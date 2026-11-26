import { stripScriptsPrefix } from "@/utils/task-target";
import { create } from "zustand";
import type {
  EpisodeScript,
  ProjectData,
  ProjectStatus,
  ProjectSummary,
  WorkspaceResponse,
} from "@/types";
import { API } from "@/api";
import { ApiRequestError } from "@/api/errors";
import { isDemoProject } from "@/onboarding/demo-project";
import { useAppStore } from "./app-store";
import { useItemLocationsStore } from "./item-locations-store";

export type RefreshProjectResult = "success" | "failed" | "cancelled";

export type ActiveEpisodeScriptStatus = "idle" | "loading" | "ready" | "missing" | "error";

export interface ActiveEpisodeScriptState {
  projectName: string | null;
  episode: number | null;
  scriptFile: string | null;
  status: ActiveEpisodeScriptStatus;
  revision: string | null;
  error: string | null;
  generation: number;
}

export type ProjectRefreshScope = {
  episodes?: number[];
  assets?: boolean;
  projectWide?: boolean;
};

interface RefreshProjectOptions {
  invalidateKeys?: string[];
  onError?: (err: unknown) => void;
  scope?: ProjectRefreshScope;
}

export interface LoadEpisodeScriptOptions {
  force?: boolean;
  speculative?: boolean;
  onError?: (err: unknown) => void;
}

export function normalizeScriptFile(scriptFile: string | null | undefined): string | null {
  if (!scriptFile) return null;
  const normalized = stripScriptsPrefix(scriptFile).trim();
  return normalized || null;
}

export function episodeScriptRevisionKey(projectName: string, episode: number): string {
  return `${projectName}::${episode}`;
}

export function episodeHasFormalScript(
  episode: { script_file?: string; script_status?: string } | undefined,
): boolean {
  if (!episode) return false;
  const bound = normalizeScriptFile(episode.script_file);
  if (!bound) return false;
  return episode.script_status !== "none" && episode.script_status !== "segmented";
}

export function mergeWorkspaceProject(res: WorkspaceResponse, previous?: ProjectData | null): ProjectData {
  const summary = res.summary;
  const byEpisode = new Map(summary.episodes.map((row) => [row.episode, row]));
  const previousRows = new Map(previous?.episodes.map((ep) => [ep.episode, ep]));
  const episodes = (res.project.episodes ?? []).map((ep) => {
    const row = byEpisode.get(ep.episode) ?? previousRows.get(ep.episode);
    if (!row) return ep;
    return {
      ...ep,
      script_status: row.script_status,
      status: row.status,
      item_count: row.item_count,
      duration_seconds: row.duration_seconds,
      needs_replan: row.needs_replan,
      storyboards: row.storyboards,
      videos: row.videos,
    };
  });
  const status: ProjectStatus = {
    currency: summary.currency,
    needs_repair: summary.needs_repair,
    repair_reason: summary.repair_reason,
    assets: previous?.status?.assets ?? summary.assets,
    episodes_summary: summary.episodes_summary ?? {
      total: episodes.length,
      scripted: episodes.filter((ep) => ep.script_status === "generated").length,
      in_production: episodes.filter((ep) => ep.status === "in_production").length,
      completed: episodes.filter((ep) => ep.status === "completed").length,
    },
    source_remaining: summary.source_remaining,
  };
  return {
    ...res.project,
    status,
    episodes,
  };
}

const IDLE_ACTIVE_SCRIPT: ActiveEpisodeScriptState = {
  projectName: null,
  episode: null,
  scriptFile: null,
  status: "idle",
  revision: null,
  error: null,
  generation: 0,
};

function mergeScopes(
  left: ProjectRefreshScope | undefined,
  right: ProjectRefreshScope | undefined,
): ProjectRefreshScope | undefined {
  if (!left || left.projectWide || !right || right.projectWide) return undefined;
  const episodes = new Set([...(left.episodes ?? []), ...(right.episodes ?? [])]);
  return {
    episodes: episodes.size > 0 ? [...episodes] : undefined,
    assets: Boolean(left.assets || right.assets),
    projectWide: false,
  };
}

function scopeTouchesEpisode(scope: ProjectRefreshScope | undefined, episode: number): boolean {
  if (!scope || scope.projectWide) return true;
  if (!scope.episodes) return false;
  return scope.episodes.includes(episode);
}

function scopeTouchesAssets(scope: ProjectRefreshScope | undefined): boolean {
  if (!scope || scope.projectWide) return true;
  return Boolean(scope.assets);
}

function isNotFoundError(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 404;
}

interface ProjectsState {
  projects: ProjectSummary[];
  projectsLoading: boolean;

  currentProjectName: string | null;
  currentProjectData: ProjectData | null;
  currentScripts: Record<string, EpisodeScript>;
  activeEpisodeScript: ActiveEpisodeScriptState;
  projectDetailLoading: boolean;

  projectSnapshotRevisions: Record<string, number>;
  projectWideRevisions: Record<string, number>;
  episodeRevisions: Record<string, number>;
  assetRevisions: Record<string, number>;

  showCreateModal: boolean;
  creatingProject: boolean;

  assetFingerprints: Record<string, number>;

  hasLoadedAnyProject: boolean;

  setProjects: (projects: ProjectSummary[]) => void;
  setProjectsLoading: (loading: boolean) => void;
  setCurrentProject: (
    name: string | null,
    data: ProjectData | null,
    scripts?: Record<string, EpisodeScript>,
    fingerprints?: Record<string, number>,
    scope?: ProjectRefreshScope,
  ) => void;
  setProjectDetailLoading: (loading: boolean) => void;
  setShowCreateModal: (show: boolean) => void;
  setCreatingProject: (creating: boolean) => void;
  updateAssetFingerprints: (fps: Record<string, number>) => void;
  getAssetFingerprint: (path: string) => number | null;
  loadEpisodeScript: (
    projectName: string,
    episode: number,
    scriptFile: string,
    options?: LoadEpisodeScriptOptions,
  ) => Promise<RefreshProjectResult>;
  clearActiveEpisodeScript: () => void;
  refreshProject: (name: string, options?: RefreshProjectOptions) => Promise<RefreshProjectResult>;
}

export const useProjectsStore = create<ProjectsState>((set, get) => {
  let refreshRunning = false;
  let refreshQueued = false;
  let queuedName: string | null = null;
  let queuedKeys: string[] = [];
  let queuedScope: ProjectRefreshScope | undefined = undefined;
  let queuedHasScope = false;
  let queuedOnErrors: Array<(err: unknown) => void> = [];
  let queuedResolvers: Array<(result: RefreshProjectResult) => void> = [];

  let projectScope = new AbortController();
  let scriptScope = new AbortController();
  let scriptGeneration = 0;
  let pendingScript: Promise<RefreshProjectResult> | null = null;

  const rotateProjectScope = () => {
    projectScope.abort();
    projectScope = new AbortController();
  };

  const rotateScriptScope = () => {
    scriptScope.abort();
    scriptScope = new AbortController();
    scriptGeneration += 1;
    return { signal: scriptScope.signal, generation: scriptGeneration };
  };

  const loadEpisodeScriptInternal = async (
    projectName: string,
    episode: number,
    rawScriptFile: string,
    options: LoadEpisodeScriptOptions = {},
  ): Promise<RefreshProjectResult> => {
    const scriptFile = normalizeScriptFile(rawScriptFile);
    if (!projectName || !scriptFile || isDemoProject(projectName)) return "cancelled";

    const current = get();
    const active = current.activeEpisodeScript;
    const sameTarget =
      active.projectName === projectName &&
      active.episode === episode &&
      active.scriptFile === scriptFile;

    if (!options.force && sameTarget) {
      if (active.status === "missing") return "success";
      if (active.status === "ready" && scriptFile in current.currentScripts) return "success";
      if (active.status === "loading" && pendingScript) {
        const result = await pendingScript;
        if (result === "failed" && active.generation === scriptGeneration) {
          options.onError?.(new Error(get().activeEpisodeScript.error ?? ""));
        }
        return result;
      }
    }

    const { signal, generation } = rotateScriptScope();
    const keepExisting = sameTarget && scriptFile in current.currentScripts;
    set((s) => ({
      currentScripts: keepExisting ? s.currentScripts : {},
      activeEpisodeScript: {
        projectName,
        episode,
        scriptFile,
        status: "loading",
        revision: keepExisting ? s.activeEpisodeScript.revision : null,
        error: null,
        generation,
      },
    }));

    const read = async (): Promise<RefreshProjectResult> => {
      try {
        const snapshot = await API.getScript(projectName, scriptFile, { signal });
        if (options.speculative && !signal.aborted && !get().currentProjectData) {
          await new Promise<void>((resolve) => {
            const finish = () => {
              unsubscribe();
              signal.removeEventListener("abort", finish);
              resolve();
            };
            const unsubscribe = useProjectsStore.subscribe((state) => {
              if (state.currentProjectData) finish();
            });
            signal.addEventListener("abort", finish, { once: true });
          });
        }
        const latest = get();
        if (signal.aborted || generation !== scriptGeneration) return "cancelled";
        const stillTarget =
          latest.currentProjectName === projectName &&
          latest.activeEpisodeScript.projectName === projectName &&
          latest.activeEpisodeScript.episode === episode &&
          latest.activeEpisodeScript.scriptFile === scriptFile &&
          latest.activeEpisodeScript.generation === generation;
        if (!stillTarget) return "cancelled";

        if (latest.currentProjectData) {
          const epMeta = latest.currentProjectData.episodes.find((entry) => entry.episode === episode);
          const bound = normalizeScriptFile(epMeta?.script_file);
          if (!epMeta || !episodeHasFormalScript(epMeta) || bound !== scriptFile) {
            return "cancelled";
          }
        }

        set({
          currentScripts: { [scriptFile]: snapshot.script },
          activeEpisodeScript: {
            projectName,
            episode,
            scriptFile,
            status: "ready",
            revision: snapshot.revision,
            error: null,
            generation,
          },
        });
        return "success";
      } catch (err) {
        if (signal.aborted || generation !== scriptGeneration) return "cancelled";
        const latest = get();
        if (
          latest.currentProjectName !== projectName ||
          latest.activeEpisodeScript.generation !== generation
        ) {
          return "cancelled";
        }
        if (isNotFoundError(err) && !options.force) {
          set({
            currentScripts: {},
            activeEpisodeScript: {
              projectName,
              episode,
              scriptFile,
              status: "missing",
              revision: null,
              error: null,
              generation,
            },
          });
          return "success";
        }
        const message = err instanceof Error ? err.message : String(err);
        set((s) => ({
          activeEpisodeScript: {
            ...s.activeEpisodeScript,
            status: "error",
            error: message,
          },
        }));
        if (!options.speculative) {
          options.onError?.(err);
        }
        return "failed";
      }
    };
    pendingScript = read();
    return pendingScript;
  };

  const reconcileActiveEpisodeAfterWorkspace = async (
    projectName: string,
    project: ProjectData,
    wasInitialLoad: boolean,
    scope: ProjectRefreshScope | undefined,
    onError: (err: unknown) => void,
  ): Promise<RefreshProjectResult> => {
    const active = get().activeEpisodeScript;
    if (active.projectName !== projectName || active.episode === null) return "success";

    const epMeta = project.episodes.find((entry) => entry.episode === active.episode);
    const boundFile = normalizeScriptFile(epMeta?.script_file);
    const hasFormal = episodeHasFormalScript(epMeta);

    if (!hasFormal || !boundFile) {
      rotateScriptScope();
      set({
        currentScripts: {},
        activeEpisodeScript: {
          projectName,
          episode: active.episode,
          scriptFile: boundFile,
          status: "missing",
          revision: null,
          error: null,
          generation: scriptGeneration,
        },
      });
      return "success";
    }

    if (boundFile === active.scriptFile && (
      (wasInitialLoad && (active.status === "loading" || active.status === "ready" || active.status === "missing")) ||
      !scopeTouchesEpisode(scope, active.episode)
    )) return "success";

    return loadEpisodeScriptInternal(projectName, active.episode, boundFile, { force: true, onError });
  };

  const commitCurrentProject = (
    name: string | null,
    data: ProjectData | null,
    scripts: Record<string, EpisodeScript> | undefined,
    fingerprints: Record<string, number> | undefined,
    scope: ProjectRefreshScope | undefined,
    rotateOnChange: boolean,
  ) => {
    const prevName = get().currentProjectName;
    const projectChanged = name !== prevName;
    if (projectChanged && rotateOnChange) {
      rotateProjectScope();
      rotateScriptScope();
      useItemLocationsStore.getState().reset(name);
    } else if (projectChanged) {
      if (get().activeEpisodeScript.projectName !== null && get().activeEpisodeScript.projectName !== name) {
        rotateScriptScope();
      }
      if (useItemLocationsStore.getState().projectName !== name) {
        useItemLocationsStore.getState().reset(name);
      }
    }
    set((s) => {
      const nextScripts =
        scripts !== undefined
          ? scripts
          : projectChanged || name === null || data === null
            ? {}
            : s.currentScripts;
      const nextActiveScript =
        projectChanged || name === null
          ? { ...IDLE_ACTIVE_SCRIPT, projectName: name, generation: scriptGeneration }
          : s.activeEpisodeScript;

      if (name === null || data === null) {
        return {
          currentProjectName: name,
          currentProjectData: data,
          currentScripts: nextScripts,
          activeEpisodeScript: nextActiveScript,
          assetFingerprints: fingerprints ?? s.assetFingerprints,
          hasLoadedAnyProject: s.hasLoadedAnyProject || name !== null,
        };
      }

      const isProjectWide = !scope || Boolean(scope.projectWide);
      const nextProjectSnapshotRevisions = {
        ...s.projectSnapshotRevisions,
        [name]: (s.projectSnapshotRevisions[name] ?? 0) + 1,
      };
      const nextProjectWideRevisions = isProjectWide
        ? {
            ...s.projectWideRevisions,
            [name]: (s.projectWideRevisions[name] ?? 0) + 1,
          }
        : s.projectWideRevisions;
      const nextAssetRevisions = scopeTouchesAssets(scope)
        ? {
            ...s.assetRevisions,
            [name]: (s.assetRevisions[name] ?? 0) + 1,
          }
        : s.assetRevisions;
      let nextEpisodeRevisions = s.episodeRevisions;
      if (scope?.episodes && scope.episodes.length > 0) {
        nextEpisodeRevisions = { ...s.episodeRevisions };
        for (const ep of scope.episodes) {
          const key = episodeScriptRevisionKey(name, ep);
          nextEpisodeRevisions[key] = (nextEpisodeRevisions[key] ?? 0) + 1;
        }
      }

      return {
        currentProjectName: name,
        currentProjectData: data,
        currentScripts: nextScripts,
        activeEpisodeScript: nextActiveScript,
        projectSnapshotRevisions: nextProjectSnapshotRevisions,
        projectWideRevisions: nextProjectWideRevisions,
        episodeRevisions: nextEpisodeRevisions,
        assetRevisions: nextAssetRevisions,
        assetFingerprints: fingerprints ?? s.assetFingerprints,
        hasLoadedAnyProject: s.hasLoadedAnyProject || name !== null,
      };
    });
  };

  const runRefresh = async (
    name: string,
    keys: string[],
    scope: ProjectRefreshScope | undefined,
    onError: ((err: unknown) => void) | undefined,
    resolvers: Array<(result: RefreshProjectResult) => void>,
  ): Promise<void> => {
    let curName = name;
    let curKeys = keys;
    let curScope = scope;
    let curOnErrors = onError ? [onError] : [];
    let curResolvers = resolvers;
    const reportError = (err: unknown) => {
      curOnErrors.forEach((cb) => {
        try {
          cb(err);
        } catch (callbackErr) {
          console.error("refreshProject onError 回调失败", callbackErr);
        }
      });
    };
    let again = true;
    while (again) {
      again = false;
      let result: RefreshProjectResult = "cancelled";
      const signal = projectScope.signal;
      try {
        const before = get();
        const prior = before.currentProjectName === curName ? before.currentProjectData : null;
        const localIds = new Set(prior?.episodes.map((ep) => ep.episode));
        const requested = !curScope?.projectWide && !curScope?.assets ? curScope?.episodes : undefined;
        const episodes = requested?.length && requested.every((id) => localIds.has(id)) ? requested : undefined;
        if (requested?.length && !episodes) curScope = undefined;
        let res: WorkspaceResponse;
        try {
          res = await API.getWorkspace(curName, episodes ? { signal, episodes } : { signal });
        } catch (error) {
          if (!episodes || signal.aborted || !(error instanceof ApiRequestError) || error.status !== 400) throw error;
          curScope = undefined;
          res = await API.getWorkspace(curName, { signal });
        }
        if (res.summary.episodes_summary === null && !signal.aborted) {
          const available = new Set(res.summary.episodes.map((row) => row.episode));
          const ledger = new Map(res.project.episodes.map((ep) => [ep.episode, ep]));
          for (const row of prior?.episodes ?? []) {
            const entry = ledger.get(row.episode);
            if (!entry || normalizeScriptFile(entry.script_file) !== normalizeScriptFile(row.script_file)
              || entry.ledger_status !== row.ledger_status
              || entry.stale_script_plan_revision !== row.stale_script_plan_revision
              || entry.stale_script_plan_rebuilt_revision !== row.stale_script_plan_rebuilt_revision) continue;
            if (row.script_status !== undefined && row.status !== undefined) available.add(row.episode);
          }
          if (res.project.episodes.some((ep) => !available.has(ep.episode)) || res.summary.needs_repair !== prior?.status?.needs_repair) {
            curScope = undefined;
            res = await API.getWorkspace(curName, { signal });
          }
        }
        const { currentProjectName, currentProjectData, hasLoadedAnyProject } = get();
        const supersededByOtherProject =
          refreshQueued &&
          queuedName !== null &&
          queuedName !== curName &&
          (currentProjectName === null || queuedName === currentProjectName);
        const isCurrentProject =
          currentProjectName === curName || (currentProjectName === null && !hasLoadedAnyProject);
        if (!supersededByOtherProject && !signal.aborted && isCurrentProject) {
          const wasInitialLoad = currentProjectData === null;
          const partial = res.summary.episodes_summary === null;
          const merged = mergeWorkspaceProject(res, partial ? currentProjectData : null);
          const fingerprints = partial ? { ...get().assetFingerprints, ...res.asset_fingerprints } : res.asset_fingerprints;
          commitCurrentProject(curName, merged, undefined, fingerprints, curScope, false);
          result = await reconcileActiveEpisodeAfterWorkspace(
            curName,
            merged,
            wasInitialLoad,
            curScope,
            reportError,
          );
          if (curKeys.length > 0 && !signal.aborted) {
            useAppStore.getState().invalidateEntities(curKeys);
          }
          if (signal.aborted) result = "cancelled";
        }
      } catch (err) {
        if (signal.aborted) {
          result = "cancelled";
        } else {
          result = "failed";
          const state = get();
          if (state.currentProjectName === curName && !state.currentProjectData && state.activeEpisodeScript.status === "loading") {
            state.clearActiveEpisodeScript();
          }
          reportError(err);
        }
      }
      curResolvers.forEach((resolve) => resolve(result));
      if (refreshQueued) {
        refreshQueued = false;
        curName = queuedName ?? curName;
        curKeys = queuedKeys;
        curScope = queuedHasScope ? queuedScope : undefined;
        curOnErrors = queuedOnErrors;
        curResolvers = queuedResolvers;
        queuedName = null;
        queuedKeys = [];
        queuedScope = undefined;
        queuedHasScope = false;
        queuedOnErrors = [];
        queuedResolvers = [];
        again = true;
      }
    }
    refreshRunning = false;
  };

  return {
    projects: [],
    projectsLoading: false,
    currentProjectName: null,
    currentProjectData: null,
    currentScripts: {},
    activeEpisodeScript: IDLE_ACTIVE_SCRIPT,
    projectDetailLoading: false,
    projectSnapshotRevisions: {},
    projectWideRevisions: {},
    episodeRevisions: {},
    assetRevisions: {},
    showCreateModal: false,
    creatingProject: false,
    assetFingerprints: {},
    hasLoadedAnyProject: false,

    setProjects: (projects) => set({ projects }),
    setProjectsLoading: (loading) => set({ projectsLoading: loading }),
    setCurrentProject: (name, data, scripts, fingerprints, scope) => {
      commitCurrentProject(name, data, scripts, fingerprints, scope, true);
    },
    setProjectDetailLoading: (loading) => set({ projectDetailLoading: loading }),
    setShowCreateModal: (show) => set({ showCreateModal: show }),
    setCreatingProject: (creating) => set({ creatingProject: creating }),
    updateAssetFingerprints: (fps) =>
      set((s) => ({ assetFingerprints: { ...s.assetFingerprints, ...fps } })),
    getAssetFingerprint: (path) => get().assetFingerprints[path] ?? null,

    loadEpisodeScript: loadEpisodeScriptInternal,
    clearActiveEpisodeScript: () => {
      const active = get().activeEpisodeScript;
      if (active.projectName && isDemoProject(active.projectName)) return;
      if (isDemoProject(get().currentProjectName)) return;
      rotateScriptScope();
      set((s) => ({
        currentScripts: {},
        activeEpisodeScript: {
          ...IDLE_ACTIVE_SCRIPT,
          projectName: s.currentProjectName,
          generation: scriptGeneration,
        },
      }));
    },

    refreshProject: (name, options) => {
      if (!name) return Promise.resolve("cancelled");
      if (isDemoProject(name)) return Promise.resolve("success");
      const invalidateKeys = options?.invalidateKeys ?? [];
      return new Promise<RefreshProjectResult>((resolve) => {
        if (refreshRunning) {
          if (refreshQueued && queuedName !== null && queuedName !== name) {
            const { currentProjectName } = get();
            if (currentProjectName !== null && queuedName === currentProjectName && name !== currentProjectName) {
              resolve("cancelled");
              return;
            }
            const supersededResolvers = queuedResolvers;
            queuedResolvers = [];
            queuedKeys = [];
            queuedScope = undefined;
            queuedHasScope = false;
            queuedOnErrors = [];
            supersededResolvers.forEach((r) => r("cancelled"));
          }
          refreshQueued = true;
          queuedName = name;
          queuedKeys = [...queuedKeys, ...invalidateKeys];
          queuedScope = queuedHasScope ? mergeScopes(queuedScope, options?.scope) : options?.scope;
          queuedHasScope = true;
          if (options?.onError) {
            queuedOnErrors = [...queuedOnErrors, options.onError];
          }
          queuedResolvers = [...queuedResolvers, resolve];
          return;
        }
        refreshRunning = true;
        void runRefresh(
          name,
          invalidateKeys,
          options?.scope,
          options?.onError,
          [resolve],
        );
      });
    },
  };
});
