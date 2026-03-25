import {
  ExecutionProcess,
  ExecutionProcessStatus,
  PatchType,
} from 'shared/types';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streamJsonPatchEntries } from '@/shared/lib/streamJsonPatchEntries';
import type {
  AddEntryType,
  ConversationTimelineSource,
  ExecutionProcessStateStore,
  PatchTypeWithKey,
  UseConversationHistoryParams,
} from '@/shared/hooks/useConversationHistory/types';

// Result type for the new UI's conversation history hook
export interface UseConversationHistoryResult {
  /** Whether the conversation only has a single coding agent turn (no follow-ups) */
  isFirstTurn: boolean;
  /** Whether background batches are still loading older history entries */
  isLoadingHistory: boolean;
}
import {
  MIN_INITIAL_ENTRIES,
  REMAINING_BATCH_SIZE,
} from '@/shared/hooks/useConversationHistory/constants';

export const useConversationHistory = ({
  onTimelineUpdated,
  scopeKey,
}: UseConversationHistoryParams): UseConversationHistoryResult => {
  const { chatHistoryTailEntries } = useUserSystem();
  const {
    executionProcessesVisible: executionProcessesRaw,
    isLoading,
    isConnected,
  } = useExecutionProcessesContext();
  const executionProcesses = useRef<ExecutionProcess[]>(executionProcessesRaw);
  const displayedExecutionProcesses = useRef<ExecutionProcessStateStore>({});
  const loadedInitialEntries = useRef(false);
  const emittedEmptyInitialRef = useRef(false);
  const streamingProcessIdsRef = useRef<Set<string>>(new Set());
  const onTimelineUpdatedRef = useRef<
    UseConversationHistoryParams['onTimelineUpdated'] | null
  >(null);
  const previousStatusMapRef = useRef<Map<string, ExecutionProcessStatus>>(
    new Map()
  );
  const [isLoadingHistoryState, setIsLoadingHistory] = useState(false);

  // Derive whether this is the first turn (no follow-up processes exist)
  const isFirstTurn = useMemo(() => {
    const codingAgentProcessCount = executionProcessesRaw.filter(
      (ep) =>
        ep.executor_action.typ.type === 'CodingAgentInitialRequest' ||
        ep.executor_action.typ.type === 'CodingAgentFollowUpRequest'
    ).length;
    return codingAgentProcessCount <= 1;
  }, [executionProcessesRaw]);

  const mergeIntoDisplayed = (
    mutator: (state: ExecutionProcessStateStore) => void
  ) => {
    const state = displayedExecutionProcesses.current;
    mutator(state);
  };

  const isConversationExecutionProcess = (
    executionProcess:
      | Pick<ExecutionProcess, 'executor_action'>
      | {
          executor_action: ExecutionProcess['executor_action'];
        }
  ) => {
    const type = executionProcess.executor_action.typ.type;
    return (
      type === 'CodingAgentInitialRequest' ||
      type === 'CodingAgentFollowUpRequest' ||
      type === 'ReviewRequest'
    );
  };

  // The hook owns transport, loading, and reconciliation.
  // It emits a source model that later derivation layers can transform further.

  const buildTimelineSource = useCallback(
    (
      executionProcessState: ExecutionProcessStateStore
    ): ConversationTimelineSource => ({
      executionProcessState,
      liveExecutionProcesses: executionProcesses.current,
    }),
    []
  );

  useEffect(() => {
    onTimelineUpdatedRef.current = onTimelineUpdated;
  }, [onTimelineUpdated]);

  // Keep executionProcesses up to date
  useEffect(() => {
    executionProcesses.current = executionProcessesRaw.filter(
      (ep) =>
        ep.run_reason === 'setupscript' ||
        ep.run_reason === 'cleanupscript' ||
        ep.run_reason === 'archivescript' ||
        ep.run_reason === 'codingagent'
    );
  }, [executionProcessesRaw]);

  const loadEntriesForHistoricExecutionProcess = (
    executionProcess: ExecutionProcess
  ) => {
    let url = '';
    if (executionProcess.executor_action.typ.type === 'ScriptRequest') {
      url = `/api/execution-processes/${executionProcess.id}/raw-logs/ws`;
    } else {
      url = `/api/execution-processes/${executionProcess.id}/normalized-logs/ws`;
    }

    return new Promise<PatchType[]>((resolve) => {
      const controller = streamJsonPatchEntries<PatchType>(url, {
        onFinished: (allEntries) => {
          controller.close();
          resolve(allEntries);
        },
        onError: (err) => {
          console.warn(
            `Error loading entries for historic execution process ${executionProcess.id}`,
            err
          );
          controller.close();
          resolve([]);
        },
      });
    });
  };

  const patchWithKey = (
    patch: PatchType,
    executionProcessId: string,
    index: number
  ) => {
    return {
      ...patch,
      patchKey: `${executionProcessId}:${index}`,
      executionProcessId,
    };
  };

  const flattenEntries = (
    executionProcessState: ExecutionProcessStateStore
  ): PatchTypeWithKey[] => {
    return Object.values(executionProcessState)
      .filter((p) => isConversationExecutionProcess(p.executionProcess))
      .sort(
        (a, b) =>
          new Date(
            a.executionProcess.created_at as unknown as string
          ).getTime() -
          new Date(b.executionProcess.created_at as unknown as string).getTime()
      )
      .flatMap((p) => p.entries);
  };

  const getActiveAgentProcesses = (): ExecutionProcess[] => {
    return (
      executionProcesses?.current.filter(
        (p) =>
          p.status === ExecutionProcessStatus.running &&
          p.run_reason !== 'devserver'
      ) ?? []
    );
  };

  const applyHistoricConversationTailLimit = useCallback(
    (executionProcessState: ExecutionProcessStateStore) => {
      if (chatHistoryTailEntries == null) return;

      const runningProcessIds = new Set(
        executionProcesses.current
          .filter(
            (process) =>
              process.status === ExecutionProcessStatus.running &&
              process.run_reason !== 'devserver'
          )
          .map((process) => process.id)
      );
      let remaining = chatHistoryTailEntries;

      for (const processState of Object.values(executionProcessState)
        .filter(
          (state) =>
            isConversationExecutionProcess(state.executionProcess) &&
            !runningProcessIds.has(state.executionProcess.id)
        )
        .sort(
          (a, b) =>
            new Date(
              b.executionProcess.created_at as unknown as string
            ).getTime() -
            new Date(
              a.executionProcess.created_at as unknown as string
            ).getTime()
        )) {
        if (remaining === 0) {
          delete executionProcessState[processState.executionProcess.id];
          continue;
        }

        const entryCount = processState.entries.length;
        if (entryCount <= remaining) {
          remaining -= entryCount;
          continue;
        }

        executionProcessState[processState.executionProcess.id] = {
          ...processState,
          entries: processState.entries.slice(entryCount - remaining),
        };
        remaining = 0;
      }
    },
    [chatHistoryTailEntries]
  );

  const emitEntries = useCallback(
    (
      executionProcessState: ExecutionProcessStateStore,
      addEntryType: AddEntryType,
      loading: boolean
    ) => {
      const timelineSource = buildTimelineSource(executionProcessState);
      let modifiedAddEntryType = addEntryType;

      const latestEntry = Object.values(executionProcessState)
        .sort(
          (a, b) =>
            new Date(
              a.executionProcess.created_at as unknown as string
            ).getTime() -
            new Date(
              b.executionProcess.created_at as unknown as string
            ).getTime()
        )
        .flatMap((processState) => processState.entries)
        .at(-1);

      if (
        latestEntry?.type === 'NORMALIZED_ENTRY' &&
        latestEntry.content.entry_type.type === 'tool_use' &&
        latestEntry.content.entry_type.tool_name === 'ExitPlanMode'
      ) {
        modifiedAddEntryType = 'plan';
      }

      onTimelineUpdatedRef.current?.(
        timelineSource,
        modifiedAddEntryType,
        loading
      );
    },
    [buildTimelineSource]
  );

  // This emits its own events as they are streamed
  const loadRunningAndEmit = useCallback(
    (executionProcess: ExecutionProcess): Promise<void> => {
      return new Promise((resolve, reject) => {
        let url = '';
        if (executionProcess.executor_action.typ.type === 'ScriptRequest') {
          url = `/api/execution-processes/${executionProcess.id}/raw-logs/ws`;
        } else {
          url = `/api/execution-processes/${executionProcess.id}/normalized-logs/ws`;
        }
        const controller = streamJsonPatchEntries<PatchType>(url, {
          onEntries(entries) {
            const patchesWithKey = entries.map((entry, index) =>
              patchWithKey(entry, executionProcess.id, index)
            );
            mergeIntoDisplayed((state) => {
              state[executionProcess.id] = {
                executionProcess,
                entries: patchesWithKey,
              };
            });
            emitEntries(displayedExecutionProcesses.current, 'running', false);
          },
          onFinished: () => {
            emitEntries(displayedExecutionProcesses.current, 'running', false);
            controller.close();
            resolve();
          },
          onError: () => {
            controller.close();
            reject();
          },
        });
      });
    },
    [emitEntries]
  );

  // Sometimes it can take a few seconds for the stream to start, wrap the loadRunningAndEmit method
  const loadRunningAndEmitWithBackoff = useCallback(
    async (executionProcess: ExecutionProcess) => {
      for (let i = 0; i < 20; i++) {
        try {
          await loadRunningAndEmit(executionProcess);
          break;
        } catch (_) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    },
    [loadRunningAndEmit]
  );

  const loadHistoricEntries = useCallback(
    async (maxEntries?: number): Promise<ExecutionProcessStateStore> => {
      const localDisplayedExecutionProcesses: ExecutionProcessStateStore = {};

      if (!executionProcesses?.current) return localDisplayedExecutionProcesses;
      if (chatHistoryTailEntries === 0) return localDisplayedExecutionProcesses;

      for (const executionProcess of [
        ...executionProcesses.current,
      ].reverse()) {
        if (executionProcess.status === ExecutionProcessStatus.running)
          continue;

        const entries =
          await loadEntriesForHistoricExecutionProcess(executionProcess);
        const entriesWithKey = entries.map((e, idx) =>
          patchWithKey(e, executionProcess.id, idx)
        );

        localDisplayedExecutionProcesses[executionProcess.id] = {
          executionProcess,
          entries: entriesWithKey,
        };
        applyHistoricConversationTailLimit(localDisplayedExecutionProcesses);

        if (
          maxEntries != null &&
          flattenEntries(localDisplayedExecutionProcesses).length >= maxEntries
        ) {
          break;
        }

        if (
          chatHistoryTailEntries != null &&
          flattenEntries(localDisplayedExecutionProcesses).length >=
            chatHistoryTailEntries
        ) {
          break;
        }
      }

      return localDisplayedExecutionProcesses;
    },
    [
      applyHistoricConversationTailLimit,
      chatHistoryTailEntries,
      executionProcesses,
    ]
  );

  const loadRemainingEntriesInBatches = useCallback(
    async (batchSize: number): Promise<boolean> => {
      if (!executionProcesses?.current) return false;
      if (chatHistoryTailEntries === 0) return false;
      if (
        chatHistoryTailEntries != null &&
        flattenEntries(displayedExecutionProcesses.current).length >=
          chatHistoryTailEntries
      ) {
        return false;
      }

      let anyUpdated = false;
      for (const executionProcess of [
        ...executionProcesses.current,
      ].reverse()) {
        const current = displayedExecutionProcesses.current;
        if (
          current[executionProcess.id] ||
          executionProcess.status === ExecutionProcessStatus.running
        )
          continue;

        const entries =
          await loadEntriesForHistoricExecutionProcess(executionProcess);
        const entriesWithKey = entries.map((e, idx) =>
          patchWithKey(e, executionProcess.id, idx)
        );

        mergeIntoDisplayed((state) => {
          state[executionProcess.id] = {
            executionProcess,
            entries: entriesWithKey,
          };
          applyHistoricConversationTailLimit(state);
        });

        if (
          chatHistoryTailEntries != null &&
          flattenEntries(displayedExecutionProcesses.current).length >=
            chatHistoryTailEntries
        ) {
          anyUpdated = true;
          break;
        }

        if (
          flattenEntries(displayedExecutionProcesses.current).length >=
          batchSize
        ) {
          anyUpdated = true;
          break;
        }
        anyUpdated = true;
      }
      return anyUpdated;
    },
    [
      applyHistoricConversationTailLimit,
      chatHistoryTailEntries,
      executionProcesses,
    ]
  );

  const ensureProcessVisible = useCallback((p: ExecutionProcess) => {
    mergeIntoDisplayed((state) => {
      if (!state[p.id]) {
        state[p.id] = {
          executionProcess: {
            id: p.id,
            created_at: p.created_at,
            updated_at: p.updated_at,
            executor_action: p.executor_action,
          },
          entries: [],
        };
      }
    });
  }, []);

  const idListKey = useMemo(
    () => executionProcessesRaw?.map((p) => p.id).join(','),
    [executionProcessesRaw]
  );

  const idStatusKey = useMemo(
    () => executionProcessesRaw?.map((p) => `${p.id}:${p.status}`).join(','),
    [executionProcessesRaw]
  );

  // Clean up entries for processes that have been removed (e.g., after reset)
  useEffect(() => {
    if (isLoading || !isConnected) return;
    const visibleProcessIds = new Set(executionProcessesRaw.map((p) => p.id));
    const displayedIds = Object.keys(displayedExecutionProcesses.current);
    let changed = false;

    for (const id of displayedIds) {
      if (!visibleProcessIds.has(id)) {
        delete displayedExecutionProcesses.current[id];
        changed = true;
      }
    }

    if (changed) {
      emitEntries(displayedExecutionProcesses.current, 'historic', false);
    }
  }, [idListKey, executionProcessesRaw, emitEntries, isLoading, isConnected]);

  useEffect(() => {
    displayedExecutionProcesses.current = {};
    loadedInitialEntries.current = false;
    emittedEmptyInitialRef.current = false;
    streamingProcessIdsRef.current.clear();
    previousStatusMapRef.current.clear();
    emitEntries(displayedExecutionProcesses.current, 'initial', true);
  }, [scopeKey, emitEntries]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (loadedInitialEntries.current) return;

      if (isLoading) return;

      if (executionProcesses.current.length === 0) {
        if (emittedEmptyInitialRef.current) return;
        emittedEmptyInitialRef.current = true;
        emitEntries(displayedExecutionProcesses.current, 'initial', false);
        return;
      }

      emittedEmptyInitialRef.current = false;

      const initialHistoricEntryTarget =
        chatHistoryTailEntries == null
          ? MIN_INITIAL_ENTRIES
          : Math.min(MIN_INITIAL_ENTRIES, chatHistoryTailEntries);
      const allInitialEntries = await loadHistoricEntries(
        initialHistoricEntryTarget
      );
      if (cancelled) return;
      loadedInitialEntries.current = true;
      mergeIntoDisplayed((state) => {
        Object.assign(state, allInitialEntries);
      });
      emitEntries(displayedExecutionProcesses.current, 'initial', false);

      setIsLoadingHistory(true);
      while (
        !cancelled &&
        (await loadRemainingEntriesInBatches(REMAINING_BATCH_SIZE))
      ) {
        if (cancelled) return;
        emitEntries(displayedExecutionProcesses.current, 'historic', false);
      }
      if (!cancelled) setIsLoadingHistory(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    scopeKey,
    idListKey,
    isLoading,
    chatHistoryTailEntries,
    loadHistoricEntries,
    loadRemainingEntriesInBatches,
    emitEntries,
  ]); // include idListKey so new processes trigger reload

  useEffect(() => {
    const activeProcesses = getActiveAgentProcesses();
    if (activeProcesses.length === 0) return;

    for (const activeProcess of activeProcesses) {
      if (!displayedExecutionProcesses.current[activeProcess.id]) {
        const runningOrInitial =
          Object.keys(displayedExecutionProcesses.current).length > 1
            ? 'running'
            : 'initial';
        ensureProcessVisible(activeProcess);
        emitEntries(
          displayedExecutionProcesses.current,
          runningOrInitial,
          false
        );
      }

      if (
        activeProcess.status === ExecutionProcessStatus.running &&
        !streamingProcessIdsRef.current.has(activeProcess.id)
      ) {
        streamingProcessIdsRef.current.add(activeProcess.id);
        loadRunningAndEmitWithBackoff(activeProcess).finally(() => {
          streamingProcessIdsRef.current.delete(activeProcess.id);
        });
      }
    }
  }, [
    scopeKey,
    idStatusKey,
    emitEntries,
    ensureProcessVisible,
    loadRunningAndEmitWithBackoff,
  ]);

  useEffect(() => {
    if (!executionProcessesRaw) return;

    const processesToReload: ExecutionProcess[] = [];

    for (const process of executionProcessesRaw) {
      const previousStatus = previousStatusMapRef.current.get(process.id);
      const currentStatus = process.status;

      if (
        previousStatus === ExecutionProcessStatus.running &&
        currentStatus !== ExecutionProcessStatus.running &&
        displayedExecutionProcesses.current[process.id]
      ) {
        processesToReload.push(process);
      }

      previousStatusMapRef.current.set(process.id, currentStatus);
    }

    if (processesToReload.length === 0) return;

    (async () => {
      let anyUpdated = false;

      for (const process of processesToReload) {
        const entries = await loadEntriesForHistoricExecutionProcess(process);
        if (entries.length === 0) continue;

        const entriesWithKey = entries.map((e, idx) =>
          patchWithKey(e, process.id, idx)
        );

        mergeIntoDisplayed((state) => {
          state[process.id] = {
            executionProcess: process,
            entries: entriesWithKey,
          };
          applyHistoricConversationTailLimit(state);
        });
        anyUpdated = true;
      }

      if (anyUpdated) {
        emitEntries(displayedExecutionProcesses.current, 'running', false);
      }
    })();
  }, [
    applyHistoricConversationTailLimit,
    idStatusKey,
    executionProcessesRaw,
    emitEntries,
  ]);

  // If an execution process is removed, remove it from the state
  useEffect(() => {
    if (!executionProcessesRaw) return;

    const removedProcessIds = Object.keys(
      displayedExecutionProcesses.current
    ).filter((id) => !executionProcessesRaw.some((p) => p.id === id));

    if (removedProcessIds.length > 0) {
      mergeIntoDisplayed((state) => {
        removedProcessIds.forEach((id) => {
          delete state[id];
        });
      });
    }
  }, [scopeKey, idListKey, executionProcessesRaw]);

  return { isFirstTurn, isLoadingHistory: isLoadingHistoryState };
};
