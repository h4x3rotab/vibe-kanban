import {
  ExecutionProcess,
  ExecutionProcessStatus,
  PatchType,
} from 'shared/types';
import { useExecutionProcessesContext } from '@/shared/hooks/useExecutionProcessesContext';
import { useUserSystem } from '@/shared/hooks/useUserSystem';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streamJsonPatchEntries } from '@/shared/lib/streamJsonPatchEntries';
import { DEFAULT_CHAT_HISTORY_PAGE_SIZE } from '@/shared/hooks/useConversationHistory/constants';
import type {
  AddEntryType,
  ConversationTimelineSource,
  ExecutionProcessStateStore,
  UseConversationHistoryParams,
} from '@/shared/hooks/useConversationHistory/types';

// Result type for the new UI's conversation history hook
export interface UseConversationHistoryResult {
  /** Whether the conversation only has a single coding agent turn (no follow-ups) */
  isFirstTurn: boolean;
  /** Whether the initial historical page is loading */
  isLoadingHistory: boolean;
  /** Whether an older historical page is loading */
  isLoadingOlderHistory: boolean;
  /** Whether there is older historical content available to load */
  hasOlderHistory: boolean;
  loadOlderHistory: () => Promise<void>;
}

type HistoricProcessPaginationState = {
  loadedCount: number;
  hasOlderEntries: boolean;
};

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
  const historicProcessPaginationRef = useRef<
    Map<string, HistoricProcessPaginationState>
  >(new Map());
  const [isLoadingHistoryState, setIsLoadingHistory] = useState(false);
  const [isLoadingOlderHistoryState, setIsLoadingOlderHistory] =
    useState(false);
  const [hasOlderHistoryState, setHasOlderHistory] = useState(false);

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

  const loadEntriesForHistoricExecutionProcess = useCallback(
    (
      executionProcess: ExecutionProcess,
      options?: {
        tailEntries?: number;
        skipTailEntries?: number;
      }
    ) => {
      let url = '';
      if (executionProcess.executor_action.typ.type === 'ScriptRequest') {
        url = `/api/execution-processes/${executionProcess.id}/raw-logs/ws`;
      } else {
        url = `/api/execution-processes/${executionProcess.id}/normalized-logs/ws`;
      }

      const searchParams = new URLSearchParams();
      if (options?.tailEntries != null) {
        searchParams.set('tail_entries', `${options.tailEntries}`);
      }
      if (options?.skipTailEntries != null && options.skipTailEntries > 0) {
        searchParams.set('skip_tail_entries', `${options.skipTailEntries}`);
      }
      const urlWithQuery =
        searchParams.size > 0 ? `${url}?${searchParams}` : url;

      return new Promise<PatchType[]>((resolve) => {
        const controller = streamJsonPatchEntries<PatchType>(urlWithQuery, {
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
    },
    []
  );

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

  const getActiveAgentProcesses = (): ExecutionProcess[] => {
    return (
      executionProcesses?.current.filter(
        (p) =>
          p.status === ExecutionProcessStatus.running &&
          p.run_reason !== 'devserver'
      ) ?? []
    );
  };

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

  const historyPageSize =
    chatHistoryTailEntries ?? DEFAULT_CHAT_HISTORY_PAGE_SIZE;

  const getHistoricExecutionProcessesNewestFirst = useCallback(
    () =>
      [...executionProcesses.current]
        .filter((process) => process.status !== ExecutionProcessStatus.running)
        .sort(
          (a, b) =>
            new Date(b.created_at as unknown as string).getTime() -
            new Date(a.created_at as unknown as string).getTime()
        ),
    []
  );

  const computeHasOlderHistory = useCallback(() => {
    const paginationState = historicProcessPaginationRef.current;

    return getHistoricExecutionProcessesNewestFirst().some((process) => {
      const state = paginationState.get(process.id);
      return state == null || state.hasOlderEntries;
    });
  }, [getHistoricExecutionProcessesNewestFirst]);

  const loadHistoricPage = useCallback(
    async (requestedEntries: number): Promise<ExecutionProcessStateStore> => {
      const localDisplayedExecutionProcesses: ExecutionProcessStateStore = {};

      if (!executionProcesses?.current || requestedEntries <= 0) {
        setHasOlderHistory(false);
        return localDisplayedExecutionProcesses;
      }

      const historicProcesses = getHistoricExecutionProcessesNewestFirst();
      const paginationState = historicProcessPaginationRef.current;
      let remaining = requestedEntries;

      for (const executionProcess of historicProcesses) {
        if (remaining === 0) break;

        const processState = paginationState.get(executionProcess.id);
        if (processState && !processState.hasOlderEntries) {
          continue;
        }

        const entries = await loadEntriesForHistoricExecutionProcess(
          executionProcess,
          {
            tailEntries: remaining + 1,
            skipTailEntries: processState?.loadedCount ?? 0,
          }
        );

        const hasOlderEntries = entries.length > remaining;
        const visibleEntries = hasOlderEntries
          ? entries.slice(entries.length - remaining)
          : entries;

        paginationState.set(executionProcess.id, {
          loadedCount: (processState?.loadedCount ?? 0) + visibleEntries.length,
          hasOlderEntries,
        });

        if (visibleEntries.length === 0) {
          continue;
        }

        const entriesWithKey = visibleEntries.map((entry, index) =>
          patchWithKey(
            entry,
            executionProcess.id,
            (processState?.loadedCount ?? 0) + index
          )
        );

        localDisplayedExecutionProcesses[executionProcess.id] = {
          executionProcess,
          entries: entriesWithKey,
        };
        remaining -= visibleEntries.length;
      }

      setHasOlderHistory(computeHasOlderHistory());
      return localDisplayedExecutionProcesses;
    },
    [
      computeHasOlderHistory,
      getHistoricExecutionProcessesNewestFirst,
      loadEntriesForHistoricExecutionProcess,
    ]
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
    historicProcessPaginationRef.current = new Map();
    streamingProcessIdsRef.current.clear();
    previousStatusMapRef.current.clear();
    setHasOlderHistory(false);
    setIsLoadingOlderHistory(false);
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

      setIsLoadingHistory(true);

      const allHistoricEntries = await loadHistoricPage(historyPageSize);
      if (cancelled) return;
      loadedInitialEntries.current = true;
      mergeIntoDisplayed((state) => {
        Object.assign(state, allHistoricEntries);
      });
      setIsLoadingHistory(false);
      emitEntries(displayedExecutionProcesses.current, 'initial', false);
    })();
    return () => {
      cancelled = true;
      setIsLoadingHistory(false);
    };
  }, [
    scopeKey,
    idListKey,
    isLoading,
    historyPageSize,
    loadHistoricPage,
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
        const existingEntries =
          displayedExecutionProcesses.current[process.id]?.entries.length ??
          historyPageSize;
        const entries = await loadEntriesForHistoricExecutionProcess(process, {
          tailEntries: Math.max(existingEntries, historyPageSize),
        });
        if (entries.length === 0) continue;

        const entriesWithKey = entries.map((e, idx) =>
          patchWithKey(e, process.id, idx)
        );

        mergeIntoDisplayed((state) => {
          state[process.id] = {
            executionProcess: process,
            entries: entriesWithKey,
          };
        });
        historicProcessPaginationRef.current.set(process.id, {
          loadedCount: entriesWithKey.length,
          hasOlderEntries: false,
        });
        anyUpdated = true;
      }

      if (anyUpdated) {
        setHasOlderHistory(computeHasOlderHistory());
        emitEntries(displayedExecutionProcesses.current, 'running', false);
      }
    })();
  }, [
    computeHasOlderHistory,
    historyPageSize,
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
          historicProcessPaginationRef.current.delete(id);
        });
      });
      setHasOlderHistory(computeHasOlderHistory());
    }
  }, [computeHasOlderHistory, scopeKey, idListKey, executionProcessesRaw]);

  const loadOlderHistory = useCallback(async () => {
    if (isLoadingOlderHistoryState || historyPageSize <= 0) return;

    setIsLoadingOlderHistory(true);
    try {
      const olderEntries = await loadHistoricPage(historyPageSize);
      mergeIntoDisplayed((state) => {
        for (const [processId, processState] of Object.entries(olderEntries)) {
          const existingEntries = state[processId]?.entries ?? [];
          state[processId] = {
            executionProcess: processState.executionProcess,
            entries: [...processState.entries, ...existingEntries],
          };
        }
      });
      emitEntries(displayedExecutionProcesses.current, 'historic', false);
    } finally {
      setIsLoadingOlderHistory(false);
    }
  }, [
    emitEntries,
    historyPageSize,
    isLoadingOlderHistoryState,
    loadHistoricPage,
  ]);

  return {
    isFirstTurn,
    isLoadingHistory: isLoadingHistoryState,
    isLoadingOlderHistory: isLoadingOlderHistoryState,
    hasOlderHistory: hasOlderHistoryState,
    loadOlderHistory,
  };
};
