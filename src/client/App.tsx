import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { queryKnowledgeContext, type KnowledgeContextTarget } from "../domain/knowledge-query.js";
import type { CanonicalProject, EntityId } from "../domain/types.js";
import type { IncomingProjectLinks, UniverseProjectNode, WorkspaceProjectEntry, WorkspaceUniverse } from "../domain/workspace.js";
import { buildGraphProjection, type GraphProjection } from "../graph/projection.js";
import { groupPortals, selectVisiblePortals } from "../graph/radial-layout.js";
import type { SearchEntityKind, SearchHit, SearchPage } from "../search/search-adapter.js";
import {
  folderImportApi,
  loadConfiguredProject,
  projectApi,
  projectAssetApi,
  projectLibraryApi,
  projectTransferApi,
  ProjectRequestError,
  searchProject,
  setRequestLocale,
  trackProject,
  type EntityTarget,
  type FolderImportApi,
  type HistoryCheckpoint,
  type HistoryState,
  type ImportPlan,
  type ProjectApi,
  type ProjectAssetApi,
  type ProjectLibraryApi,
  type ProjectLoader,
  type ProjectMutationResponse,
  type ProjectSearch,
  type ProjectTransferApi
} from "./api/project-client.js";
import { AuthoringDialog } from "./components/AuthoringDialog.js";
import { FilePicker } from "./components/FilePicker.js";
import { FolderImportDialog } from "./components/FolderImportDialog.js";
import { Icon, Spinner } from "./components/Icon.js";
import { KnowledgeEditor } from "./components/KnowledgeEditor.js";
import { KnowledgePanel } from "./components/KnowledgePanel.js";
import { MapViewer } from "./components/MapViewer.js";
import { ProjectMenu } from "./components/ProjectMenu.js";
import { RelationshipNavigator } from "./components/RelationshipNavigator.js";
import { ProjectSettingsDialog } from "./components/ProjectSettingsDialog.js";
import { ProjectLinkDialog, type ProjectLinkSelection } from "./components/ProjectLinkDialog.js";
import { SearchScopeToggle, type SearchScope } from "./components/SearchScopeToggle.js";
import { StudioPanel, type StudioCover, type StudioText } from "./components/StudioPanel.js";
import { UniverseProjectPanel, UniverseView, type UniverseLabels } from "./components/UniverseView.js";
import type { DraftAck } from "./use-entity-draft.js";
import { directionForLocale, localeNames, messages, type Locale, type MessageKey } from "./locales.js";
import { localizeDisplayProject, localizeSearchHit } from "./display-localization.js";
import { APPLICATION_VERSION } from "../version.js";

type Theme = "light" | "dark";
type MobileView = "map" | "knowledge";
type ApplicationMode = "viewer" | "studio";
type NoticeTone = "success" | "error";
type TransferAction = "export" | "preview" | "cancel" | "commit";
type NavEntry = { kind: "topic"; instanceId: string; projectId: string; topicId: string; keyIssueId?: string; label: string; projectLabel: string } | { kind: "universe" };

const NAV_STORAGE_KEY = "outmapper:navigation:v1";
/** The longest a newly activated Project's map waits for its incoming links before it draws without them. */
const INCOMING_WAIT_MS = 700;
function initialNavigation(): { entries: NavEntry[]; cursor: number } {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(NAV_STORAGE_KEY) ?? "null") as { entries?: NavEntry[]; cursor?: number } | null;
    if (parsed && Array.isArray(parsed.entries) && Number.isInteger(parsed.cursor)) return { entries: parsed.entries.slice(-100), cursor: Math.min(parsed.cursor!, parsed.entries.length - 1) };
  } catch { /* Start with an empty session stack. */ }
  return { entries: [], cursor: -1 };
}

interface AppProps {
  loadProject?: ProjectLoader;
  api?: ProjectApi;
  assetApi?: ProjectAssetApi;
  transferApi?: ProjectTransferApi;
  libraryApi?: ProjectLibraryApi;
  folderApi?: FolderImportApi;
  search?: ProjectSearch;
}

export function App({ loadProject = loadConfiguredProject, api = projectApi, assetApi = projectAssetApi, transferApi = projectTransferApi, libraryApi = projectLibraryApi, folderApi = folderImportApi, search = searchProject }: AppProps) {
  const [locale, setLocale] = useState<Locale>("en");
  const [theme, setTheme] = useState<Theme>("dark");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("map");
  const [panelOpen, setPanelOpen] = useState(true);
  const [relationshipsOpen, setRelationshipsOpen] = useState(false);
  const [mode, setMode] = useState<ApplicationMode>("viewer");
  const [project, setProject] = useState<CanonicalProject | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [centralTopicId, setCentralTopicId] = useState<EntityId | null>(null);
  const [selectedKeyIssueId, setSelectedKeyIssueId] = useState<EntityId | undefined>();
  const [selectedRelatedTopicId, setSelectedRelatedTopicId] = useState<EntityId | undefined>();
  const [selectedPortalId, setSelectedPortalId] = useState<EntityId>();
  const [portalOverflowOpen, setPortalOverflowOpen] = useState(false);
  const [navigation, setNavigation] = useState(initialNavigation);
  const [currentView, setCurrentView] = useState<"topic" | "universe">(() => {
    const initial = initialNavigation();
    return initial.entries[initial.cursor]?.kind === "universe" ? "universe" : "topic";
  });
  const [activeInstanceId, setActiveInstanceId] = useState("");
  const [workspaceProjects, setWorkspaceProjects] = useState<WorkspaceProjectEntry[]>([]);
  const [incoming, setIncoming] = useState<IncomingProjectLinks>();
  /** Counts Project activations (the first load, each switch and each reopen); the map waits per activation. */
  const [activation, setActivation] = useState(0);
  const activationStartedAt = useRef(0);
  const [incomingReadyFor, setIncomingReadyFor] = useState<number>();
  const beginActivation = useCallback(() => {
    activationStartedAt.current = Date.now();
    setActivation((value) => value + 1);
  }, []);
  const [universe, setUniverse] = useState<WorkspaceUniverse>();
  const [universeBusy, setUniverseBusy] = useState(false);
  const [universeError, setUniverseError] = useState<string>();
  const [selectedUniverseProjectId, setSelectedUniverseProjectId] = useState<string>();
  const [universeForget, setUniverseForget] = useState<UniverseProjectNode>();
  const [projectLinkIssueId, setProjectLinkIssueId] = useState<string>();
  const [duplicateChoice, setDuplicateChoice] = useState<{ entry: Omit<Extract<NavEntry, { kind: "topic" }>, "instanceId">; projects: WorkspaceProjectEntry[] }>();
  const [rememberDuplicate, setRememberDuplicate] = useState(true);
  const [blockedNavigation, setBlockedNavigation] = useState<NavEntry>();
  const [unavailableEntry, setUnavailableEntry] = useState<Extract<NavEntry, { kind: "topic" }>>();
  const [previousProjection, setPreviousProjection] = useState<GraphProjection>();
  const [focusToken, setFocusToken] = useState(0);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [commandHistory, setCommandHistory] = useState<HistoryState>({ canUndo: false, canRedo: false });
  const [notice, setNotice] = useState<string>();
  const [noticeCanUndo, setNoticeCanUndo] = useState(false);
  const [noticeCanReload, setNoticeCanReload] = useState(false);
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("success");
  const [importPlan, setImportPlan] = useState<ImportPlan>();
  const [importDirectory, setImportDirectory] = useState("");
  const [importMode, setImportMode] = useState<"copy" | "anyway">("copy");
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferAction, setTransferAction] = useState<TransferAction>();
  const [packagePickerOpen, setPackagePickerOpen] = useState(false);
  const [packageError, setPackageError] = useState("");
  const [packageProgress, setPackageProgress] = useState<number>();
  const [folderImportOpen, setFolderImportOpen] = useState(false);
  const [addTopicOpen, setAddTopicOpen] = useState(false);
  const [topicTitle, setTopicTitle] = useState("");
  const [topicBusy, setTopicBusy] = useState(false);
  const [topicError, setTopicError] = useState("");
  const [knowledgeEditor, setKnowledgeEditor] = useState<{ associationId: string; removing: boolean }>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchKind, setSearchKind] = useState<SearchEntityKind | "all">("all");
  const [searchScope, setSearchScope] = useState<SearchScope>("project");
  const [searchPage, setSearchPage] = useState<SearchPage>({ items: [], total: 0 });
  const [searchResultText, setSearchResultText] = useState("");
  const [searchResultScope, setSearchResultScope] = useState<SearchScope>("project");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [transitioningTopicId, setTransitioningTopicId] = useState<EntityId>();
  const [resyncToken, setResyncToken] = useState(0);
  const [studioTitleFocusId, setStudioTitleFocusId] = useState<EntityId>();
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [copyOffer, setCopyOffer] = useState<WorkspaceProjectEntry>();
  const mutationQueue = useRef<Promise<unknown>>(Promise.resolve());
  const transferQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingMutations = useRef(0);
  const latestProject = useRef<CanonicalProject | null>(null);
  const studioFlush = useRef<(() => Promise<boolean>) | undefined>(undefined);
  const studioSession = useRef<{ startRevision: number; checkpoint: Promise<HistoryCheckpoint | undefined> } | undefined>(undefined);
  const noticeTimer = useRef<number | undefined>(undefined);
  const noticeUndo = useRef<(() => Promise<void>) | undefined>(undefined);
  const navigationTimer = useRef<number | undefined>(undefined);
  const importButton = useRef<HTMLButtonElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsPopover = useRef<HTMLElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const historyPopover = useRef<HTMLDivElement>(null);
  const languageSelect = useRef<HTMLDivElement>(null);
  const languageButton = useRef<HTMLButtonElement>(null);
  const languageOptions = useRef<Array<HTMLButtonElement | null>>([]);
  const searchDialog = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchResults = useRef<HTMLDivElement>(null);
  const searchRequest = useRef(0);
  const knowledgePanel = useRef<HTMLElement>(null);
  const text = useMemo(() => messages[locale], [locale]);
  const t = useCallback((key: MessageKey) => text[key], [text]);
  const updateWorkspace = useCallback((projects: WorkspaceProjectEntry[], instanceId: string) => {
    setWorkspaceProjects(projects);
    setActiveInstanceId(instanceId);
  }, []);
  const loadWorkspaceTopics = useCallback((instanceId: string) => libraryApi.topics(instanceId), [libraryApi]);
  const displayProject = useMemo(() => project ? localizeDisplayProject(project, locale) : null, [locale, project]);
  const restoreImportFocus = useCallback(() => window.setTimeout(() => (importButton.current ?? settingsButton.current)?.focus(), 0), []);

  useEffect(() => {
    let active = true;
    loadProject()
      .then((loaded) => {
        if (!active) return;
        trackProject(loaded);
        latestProject.current = loaded;
        setProject(loaded);
        beginActivation();
        setResyncToken((value) => value + 1);
        setCentralTopicId(
          loaded.manifest.homeTopicId ?? [...loaded.topics].sort((a, b) => a.id.localeCompare(b.id))[0]?.id ?? null
        );
        void libraryApi.workspace().then((workspace) => {
          if (!active) return;
          setActiveInstanceId(workspace.activeInstanceId);
          setWorkspaceProjects(Object.values(workspace.projects));
          setNavigation((current) => {
            if (current.entries.length || !workspace.activeInstanceId) return current;
            const topicId = loaded.manifest.homeTopicId ?? [...loaded.topics].sort((a, b) => a.id.localeCompare(b.id))[0]?.id;
            const topic = loaded.topics.find(({ id }) => id === topicId);
            return topic ? { entries: [{ kind: "topic", instanceId: workspace.activeInstanceId, projectId: loaded.manifest.id, topicId: topic.id, label: topic.title, projectLabel: loaded.manifest.title }], cursor: 0 } : current;
          });
        }).catch(() => { if (active) setActiveInstanceId(loaded.manifest.id); });
        setLoadError(false);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [beginActivation, libraryApi, loadAttempt, loadProject]);

  useEffect(() => {
    try { sessionStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(navigation)); } catch { /* Session history remains in memory. */ }
  }, [navigation]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = directionForLocale(locale);
    document.documentElement.dataset.theme = theme;
    // The Universe has no on-screen heading, so the page title names it.
    document.title = currentView === "universe" ? `${text.universe} · ${text.appName}` : text.appName;
    document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.setAttribute(
      "href",
      theme === "dark" ? "/brand/outmapper-mark-light.svg" : "/brand/outmapper-mark-dark.svg"
    );
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
      "content",
      theme === "dark" ? "#0b0b0d" : "#eceef2"
    );
    setRequestLocale(locale);
  }, [currentView, locale, text.appName, text.universe, theme]);

  // Incoming links change only with the active folder or the workspace registry, never with this Project's own edits.
  // Each activation's first map waits for them, so every portal enters with the graph instead of arriving later and
  // refitting the camera; however the request goes, the map is released within INCOMING_WAIT_MS of the activation.
  // What incoming links are derived from: each folder's identity, title, status and cached outgoing links. Reloading
  // the registry with the same content (as opening the Universe does) is not a change.
  const incomingSources = useMemo(() => JSON.stringify(workspaceProjects.map(({ instanceId, projectId, title, status, outgoingLinks }) =>
    [instanceId, projectId, title, status, outgoingLinks])), [workspaceProjects]);
  useEffect(() => {
    if (!activation || !libraryApi.incoming) return;
    let active = true;
    const release = () => { if (active) setIncomingReadyFor(activation); };
    const timer = window.setTimeout(release, Math.max(0, INCOMING_WAIT_MS - (Date.now() - activationStartedAt.current)));
    if (activeInstanceId) {
      void libraryApi.incoming()
        .then((result) => { if (active) setIncoming(result); })
        .catch(() => { if (active) setIncoming(undefined); })
        .finally(release);
    }
    return () => { active = false; window.clearTimeout(timer); };
  }, [activation, activeInstanceId, incomingSources, libraryApi]);
  const mapReady = !libraryApi.incoming || incomingReadyFor === activation;
  /** The map region shows its loading state until the Project loads and, once it has Topics, until its map is ready. */
  const mapLoading = !loadError && (!project || (Boolean(centralTopicId) && !mapReady));

  /** Marks which edges of the side panel have content scrolled past them, so CSS can fade only those edges. */
  useEffect(() => {
    const panel = knowledgePanel.current;
    if (!panel) return;
    const update = () => {
      const offset = `${panel.querySelector<HTMLElement>(".studio-bar")?.offsetHeight ?? 0}px`;
      if (panel.style.getPropertyValue("--scroll-fade-offset") !== offset) panel.style.setProperty("--scroll-fade-offset", offset);
      const start = String(panel.scrollTop > 1);
      const end = String(panel.scrollTop + panel.clientHeight < panel.scrollHeight - 1);
      if (panel.dataset.scrollStart !== start) panel.dataset.scrollStart = start;
      if (panel.dataset.scrollEnd !== end) panel.dataset.scrollEnd = end;
    };
    update();
    panel.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : undefined;
    observer?.observe(panel);
    if (panel.firstElementChild) observer?.observe(panel.firstElementChild);
    return () => {
      panel.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
      if (navigationTimer.current) window.clearTimeout(navigationTimer.current);
    },
    []
  );

  useEffect(() => {
    if (!importPlan) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void transferApi.cancelImport(importPlan.id).finally(() => {
        setImportPlan(undefined);
        restoreImportFocus();
      });
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [importPlan, restoreImportFocus, transferApi]);

  useEffect(() => {
    if (!searchOpen) return;
    const request = ++searchRequest.current;
    if (!searchText.trim()) {
      const suggestions: SearchHit[] = [];
      if (searchScope === "project" && displayProject && centralTopicId) {
        const centralTopic = displayProject.topics.find(({ id }) => id === centralTopicId);
        if (centralTopic) suggestions.push({
          id: centralTopic.id,
          kind: "topic",
          title: centralTopic.title,
          summary: centralTopic.description,
          contexts: [{ topicId: centralTopic.id }],
          score: 1
        });
        const issues = displayProject.keyIssues
          .filter(({ topicId }) => topicId === centralTopicId)
          .sort((left, right) => left.order - right.order)
          .slice(0, 3);
        suggestions.push(...issues.map((issue, index) => ({
          id: issue.id,
          kind: "keyIssue" as const,
          title: issue.title,
          summary: issue.description,
          contexts: [{ topicId: centralTopicId, keyIssueId: issue.id }],
          score: 0.9 - index * 0.01
        })));
        const relatedTopicIds = [...new Set(displayProject.relationships
          .filter(({ sourceTopicId }) => sourceTopicId === centralTopicId)
          .map(({ targetTopicId }) => targetTopicId))];
        suggestions.push(...relatedTopicIds.slice(0, 2).flatMap((topicId, index) => {
          const topic = displayProject.topics.find(({ id }) => id === topicId);
          return topic ? [{
            id: topic.id,
            kind: "topic" as const,
            title: topic.title,
            summary: topic.description,
            contexts: [{ topicId: topic.id }],
            score: 0.8 - index * 0.01
          }] : [];
        }));
        const relevantIds = new Set([centralTopicId, ...issues.map(({ id }) => id)]);
        const knowledgeAssociation = displayProject.associations.find(({ targetId }) => relevantIds.has(targetId));
        const knowledgeItem = knowledgeAssociation
          ? displayProject.knowledgeItems.find(({ id }) => id === knowledgeAssociation.knowledgeItemId)
          : undefined;
        if (knowledgeAssociation && knowledgeItem) suggestions.push({
          id: knowledgeItem.id,
          kind: "knowledgeItem",
          type: knowledgeItem.type,
          title: knowledgeItem.title,
          summary: knowledgeItem.summary,
          availability: knowledgeItem.availability,
          contexts: [{
            topicId: centralTopicId,
            keyIssueId: knowledgeAssociation.targetKind === "keyIssue" ? knowledgeAssociation.targetId : undefined
          }],
          score: 0.7
        });
      }
      const items = searchKind === "all" ? suggestions : suggestions.filter(({ kind }) => kind === searchKind);
      const timer = window.setTimeout(() => {
        if (request !== searchRequest.current) return;
        setSearchPage({ items, total: items.length });
        setSearchResultText("");
        setSearchResultScope(searchScope);
        setSearchError(undefined);
        setSearchBusy(false);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const pendingTimer = window.setTimeout(() => {
      if (request !== searchRequest.current) return;
      setSearchBusy(true);
      setSearchError(undefined);
      setSearchPage({ items: [], total: 0 });
    }, 0);
    const timer = window.setTimeout(() => {
      void search({
        text: searchText,
        scope: searchScope,
        match: "prefix",
        filters: searchKind === "all" ? undefined : { entityKinds: [searchKind] },
        limit: 20
      })
        .then((page) => {
          if (request === searchRequest.current) {
            setSearchPage({ ...page, items: page.items.map((hit) => localizeSearchHit(hit, locale, project?.manifest.id)) });
            setSearchResultText(searchText);
            setSearchResultScope(searchScope);
          }
        })
        .catch((error: unknown) => {
          if (request === searchRequest.current) setSearchError(error instanceof Error ? error.message : text.searchError);
        })
        .finally(() => {
          if (request === searchRequest.current) setSearchBusy(false);
        });
    }, 120);
    return () => {
      window.clearTimeout(pendingTimer);
      window.clearTimeout(timer);
    };
  }, [centralTopicId, displayProject, locale, project?.manifest.id, search, searchKind, searchOpen, searchScope, searchText, text.searchError]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase("en-US") === "k") {
        event.preventDefault();
        setSettingsOpen(false);
        setLanguageOpen(false);
        setHistoryOpen(false);
        setSelectedRelatedTopicId(undefined);
        setSearchOpen(true);
      } else if (event.key === "Escape" && document.querySelector("dialog[open]")) {
        return;
      } else if (event.key === "Escape" && searchOpen) {
        event.preventDefault();
        setSearchOpen(false);
        window.setTimeout(() => searchButton.current?.focus(), 0);
      } else if (event.key === "Escape" && languageOpen) {
        event.preventDefault();
        setLanguageOpen(false);
        window.setTimeout(() => languageButton.current?.focus(), 0);
      } else if (event.key === "Escape" && settingsOpen) {
        event.preventDefault();
        setSettingsOpen(false);
        window.setTimeout(() => settingsButton.current?.focus(), 0);
      } else if (event.key === "Escape" && historyOpen) {
        event.preventDefault();
        setHistoryOpen(false);
        window.setTimeout(() => historyButton.current?.focus(), 0);
      } else if (event.key === "Escape" && selectedUniverseProjectId) {
        event.preventDefault();
        const projectId = selectedUniverseProjectId;
        setSelectedUniverseProjectId(undefined);
        window.setTimeout(() => [...document.querySelectorAll<HTMLButtonElement>("[data-universe-project-id]")].find((node) => node.dataset.universeProjectId === projectId)?.focus(), 0);
      } else if (event.key === "Escape" && selectedPortalId) {
        event.preventDefault();
        const portalId = selectedPortalId;
        setSelectedPortalId(undefined);
        window.setTimeout(() => [...document.querySelectorAll<HTMLButtonElement>("[data-entity-id]")].find((node) => node.dataset.entityId === portalId)?.focus(), 0);
      } else if (event.key === "Escape" && selectedRelatedTopicId) {
        event.preventDefault();
        const topicId = selectedRelatedTopicId;
        setSelectedRelatedTopicId(undefined);
        window.setTimeout(() => [...document.querySelectorAll<HTMLButtonElement>("[data-entity-id]")].find((node) => node.dataset.entityId === topicId)?.focus(), 0);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [historyOpen, languageOpen, searchOpen, selectedPortalId, selectedRelatedTopicId, selectedUniverseProjectId, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen && !historyOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!languageSelect.current?.contains(target)) setLanguageOpen(false);
      if (
        settingsPopover.current?.contains(target) ||
        settingsButton.current?.contains(target) ||
        historyPopover.current?.contains(target) ||
        historyButton.current?.contains(target) ||
        (target instanceof Element && target.closest("dialog[open], .dialog-scrim"))
      ) return;
      setSettingsOpen(false);
      setLanguageOpen(false);
      setHistoryOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [historyOpen, settingsOpen]);

  // Preview cards close on a press outside them, like dialogs; a press on another map node selects that node instead.
  useEffect(() => {
    if (!selectedPortalId && !selectedRelatedTopicId) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest(".topic-preview, [data-map-node], dialog[open], .dialog-scrim")) return;
      setSelectedPortalId(undefined);
      setSelectedRelatedTopicId(undefined);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [selectedPortalId, selectedRelatedTopicId]);

  useEffect(() => {
    if (!historyOpen) return;
    const timer = window.setTimeout(() => (historyPopover.current?.querySelector<HTMLButtonElement>("[aria-current]") ?? historyPopover.current?.querySelector<HTMLButtonElement>("[role='menuitem']"))?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [historyOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const timer = window.setTimeout(() => {
      if (document.activeElement === settingsButton.current || document.activeElement === document.body) languageButton.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [settingsOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = [...(searchDialog.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
      ) ?? [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleTab);
    return () => document.removeEventListener("keydown", handleTab);
  }, [searchOpen]);

  const projection = useMemo(() => {
    if (!displayProject || !centralTopicId) return null;
    const portalProjects = workspaceProjects.reduce<Record<string, { title: string; available: boolean; lastOpenedAt?: string }>>((projects, entry) => {
      const available = entry.status === "available" || entry.status === "duplicate";
      const current = projects[entry.projectId];
      if (!current || available && !current.available || available === current.available && (entry.lastOpenedAt ?? "") > (current.lastOpenedAt ?? "")) {
        projects[entry.projectId] = { title: entry.title, available, ...(entry.lastOpenedAt ? { lastOpenedAt: entry.lastOpenedAt } : {}) };
      }
      return projects;
    }, {});
    return buildGraphProjection(displayProject, centralTopicId, {
      selectedKeyIssueId,
      selectedRelatedTopicId,
      previousProjection,
      portalProjects,
      incomingLinks: incoming?.groups.find(({ topicId }) => topicId === centralTopicId)?.links
    });
  }, [centralTopicId, displayProject, incoming, previousProjection, selectedKeyIssueId, selectedRelatedTopicId, workspaceProjects]);
  const selectedIssue = projection?.keyIssues.find(({ id }) => id === selectedKeyIssueId);
  const selectedRelatedTopic = projection?.relatedTopics.find(({ id }) => id === selectedRelatedTopicId);
  const selectedPortal = projection?.portals.find(({ id }) => id === selectedPortalId);
  const portalGroups = projection ? groupPortals(projection.portals) : [];
  // Every link between this Topic and the selected portal's Project, in the same direction.
  const selectedPortalLinks = portalGroups.find((group) => group.some(({ id }) => id === selectedPortalId)) ?? [];
  const unique = (values: string[]) => [...new Set(values)].join(", ");
  const visiblePortalIds = new Set(projection ? selectVisiblePortals(projection.portals).map(({ id }) => id) : []);
  const overflowGroups = portalGroups.filter(([first]) => !visiblePortalIds.has(first!.id));
  const connectedIssueTitles = selectedRelatedTopic?.keyIssueIds
    .map((id) => projection?.keyIssues.find((issue) => issue.id === id)?.title)
    .filter((title): title is string => Boolean(title));
  const contextTarget: KnowledgeContextTarget | null = useMemo(
    () =>
      projection
        ? selectedIssue
          ? { kind: "keyIssue", id: selectedIssue.id }
          : { kind: "topic", id: projection.centralTopic.id }
        : null,
    [projection, selectedIssue]
  );
  const knowledgeContext = useMemo(
    () => (displayProject && contextTarget ? queryKnowledgeContext(displayProject, contextTarget) : null),
    [contextTarget, displayProject]
  );
  const imageHrefFor = (assetId?: EntityId) => {
    const asset = project?.assets.find(({ id }) => id === assetId);
    return asset?.mimeType.startsWith("image/") && asset.mimeType !== "image/svg+xml"
      ? `/api/assets/${encodeURIComponent(asset.id)}`
      : undefined;
  };
  const centralCoverImageUrl = imageHrefFor(projection?.centralTopic.visualAssetId);

  const showNotice = useCallback((message: string, undo?: () => Promise<void>, tone: NoticeTone = "success") => {
    setNotice(message);
    setNoticeTone(tone);
    setNoticeCanReload(false);
    noticeUndo.current = undo;
    setNoticeCanUndo(Boolean(undo));
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(undefined), undo ? 8000 : tone === "error" ? 7000 : 2800);
  }, []);
  const applyMutation = useCallback((result: ProjectMutationResponse) => {
    // Mutations are queued, so derive the next selection from current state instead of a stale closure.
    const topicIds = new Set(result.project.topics.map(({ id }) => id));
    const fallbackTopicId = result.project.manifest.homeTopicId ?? result.project.topics[0]?.id ?? null;
    const issueIds = new Set(result.project.keyIssues.map(({ id }) => id));
    trackProject(result.project);
    latestProject.current = result.project;
    setProject(result.project);
    setCentralTopicId((current) => current && topicIds.has(current) ? current : fallbackTopicId);
    setSelectedKeyIssueId((id) => id && issueIds.has(id) ? id : undefined);
    setSelectedRelatedTopicId((id) => id && topicIds.has(id) ? id : undefined);
    setCommandHistory(result.history);
    setSaveState(pendingMutations.current > 0 ? "saving" : "saved");
  }, []);
  const activateProject = useCallback((result: ProjectMutationResponse) => {
    trackProject(result.project);
    latestProject.current = result.project;
    setProject(result.project);
    setResyncToken((value) => value + 1);
    setProjectSettingsOpen(false);
    setCentralTopicId(result.project.manifest.homeTopicId ?? result.project.topics[0]?.id ?? null);
    setSelectedKeyIssueId(undefined);
    setSelectedRelatedTopicId(undefined);
    setSelectedPortalId(undefined);
    setIncoming(undefined);
    beginActivation();
    setTransitioningTopicId(undefined);
    setRelationshipsOpen(false);
    setHistoryOpen(false);
    setMobileView("map");
    if (result.instanceId) setActiveInstanceId(result.instanceId);
    setPreviousProjection(undefined);
    setCommandHistory(result.history);
    setSaveState("saved");
    setMode("viewer");
    setCurrentView("topic");
    setFolderImportOpen(false);
    setKnowledgeEditor(undefined);
    setSettingsOpen(false);
    setFocusToken((value) => value + 1);
    if (result.historyCleared) showNotice(text.undoHistoryCleared);
  }, [beginActivation, showNotice, text.undoHistoryCleared]);
  /** Serializes client requests so each one carries the revision produced by the previous one. */
  const enqueue = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.current.then(operation, operation);
    mutationQueue.current = result.catch(() => undefined);
    return result;
  }, []);
  const runMutation = useCallback(
    async <T extends ProjectMutationResponse>(operation: () => Promise<T>, failureMessage?: string, quiet = false, keepNotice = false) => {
      if (!keepNotice) {
        setNotice(undefined);
        setNoticeCanUndo(false);
      }
      pendingMutations.current += 1;
      setSaveState("saving");
      try {
        const result = await enqueue(operation);
        pendingMutations.current -= 1;
        applyMutation(result);
        return result;
      } catch (error) {
        pendingMutations.current -= 1;
        setSaveState("error");
        if (!quiet) {
          const conflict = error instanceof ProjectRequestError && error.code === "conflicting-save";
          showNotice(failureMessage ?? (conflict ? text.conflictSave : error instanceof Error ? error.message : text.saveError), undefined, "error");
          if (conflict) setNoticeCanReload(true);
        }
        throw error;
      }
    },
    [applyMutation, enqueue, showNotice, text.conflictSave, text.saveError]
  );
  /** Undo and Redo replace canonical values, so open editors are told to adopt them. */
  const undoRedo = useCallback(async (direction: "undo" | "redo") => {
    await runMutation(() => direction === "undo" ? api.undo() : api.redo());
    setResyncToken((value) => value + 1);
  }, [api, runMutation]);

  const selectKeyIssue = (id: EntityId) => {
    setSelectedKeyIssueId((current) => (current === id ? undefined : id));
    setSelectedRelatedTopicId(undefined);
    setSelectedPortalId(undefined);
  };
  const selectRelatedTopic = (id: EntityId) => {
    setSelectedRelatedTopicId((current) => (current === id ? undefined : id));
    setSelectedKeyIssueId(undefined);
    setSelectedPortalId(undefined);
  };
  const clearSelection = () => {
    setSelectedKeyIssueId(undefined);
    setSelectedRelatedTopicId(undefined);
    setSelectedPortalId(undefined);
  };
  const navigateTo = async (entry: NavEntry, options: { record?: boolean; cursor?: number; force?: boolean; activated?: ProjectMutationResponse; skipTransferWait?: boolean; stayInStudio?: boolean } = {}) => {
    if (!options.force && studioFlush.current && !await studioFlush.current()) {
      setBlockedNavigation(entry);
      return;
    }
    await mutationQueue.current.catch(() => undefined);
    if (!options.skipTransferWait) await transferQueue.current.catch(() => undefined);
    if (entry.kind === "universe") {
      setCurrentView("universe");
      setMode("viewer");
      setSelectedKeyIssueId(undefined);
      setSelectedRelatedTopicId(undefined);
      setSelectedPortalId(undefined);
      setRelationshipsOpen(false);
      setHistoryOpen(false);
      setSettingsOpen(false);
      setMobileView("map");
      setFocusToken((value) => value + 1);
      if (options.cursor !== undefined) setNavigation((current) => ({ ...current, cursor: options.cursor! }));
      else if (options.record !== false) setNavigation((current) => {
        if (current.entries[current.cursor]?.kind === "universe") return current;
        const entries = [...current.entries.slice(0, current.cursor + 1), entry].slice(-100);
        return { entries, cursor: entries.length - 1 };
      });
      return;
    }
    let destinationProject = latestProject.current;
    if (options.activated) {
      activateProject(options.activated);
      destinationProject = options.activated.project;
    } else if (entry.instanceId !== activeInstanceId) {
      try {
        const activated = await libraryApi.activate(entry.instanceId);
        activateProject(activated);
        destinationProject = activated.project;
      } catch {
        setUnavailableEntry(entry);
        return;
      }
    }
    if (!destinationProject) return;
    const destinationTopic = destinationProject.topics.find(({ id }) => id === entry.topicId);
    const fallbackTopic = destinationProject.topics.find(({ id }) => id === destinationProject!.manifest.homeTopicId) ?? destinationProject.topics[0];
    const topic = destinationTopic ?? fallbackTopic;
    if (!topic) return;
    if (!destinationTopic) showNotice(text.originalTopicUnavailable);
    if (entry.instanceId === activeInstanceId && projection) setPreviousProjection(projection);
    setCentralTopicId(topic.id);
    setSelectedKeyIssueId(entry.keyIssueId && destinationProject.keyIssues.some(({ id }) => id === entry.keyIssueId) ? entry.keyIssueId : undefined);
    setSelectedRelatedTopicId(undefined);
    setSelectedPortalId(undefined);
    setTransitioningTopicId(undefined);
    setRelationshipsOpen(false);
    setHistoryOpen(false);
    if (!options.stayInStudio) setMode("viewer");
    setMobileView("map");
    setCurrentView("topic");
    setFocusToken((value) => value + 1);
    const actual: NavEntry = { ...entry, topicId: topic.id, label: topic.title, projectId: destinationProject.manifest.id, projectLabel: destinationProject.manifest.title };
    if (options.cursor !== undefined) setNavigation((current) => ({ ...current, cursor: options.cursor! }));
    else if (options.record !== false) setNavigation((current) => {
      const previous = current.entries[current.cursor];
      if (previous?.kind === "topic" && previous.instanceId === actual.instanceId && previous.topicId === actual.topicId && previous.keyIssueId === actual.keyIssueId) return current;
      const entries = [...current.entries.slice(0, current.cursor + 1), actual].slice(-100);
      return { entries, cursor: entries.length - 1 };
    });
  };
  const navigateTopic = (topicId: EntityId) => {
    if (!project || !activeInstanceId) return;
    const topic = project.topics.find(({ id }) => id === topicId);
    if (!topic) return;
    const entry: NavEntry = { kind: "topic", instanceId: activeInstanceId, projectId: project.manifest.id, topicId, label: topic.title, projectLabel: project.manifest.title };
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (projection?.relatedTopics.some(({ id }) => id === topicId) && !reduceMotion) {
      setSelectedKeyIssueId(undefined);
      setSelectedRelatedTopicId(topicId);
      setTransitioningTopicId(topicId);
      navigationTimer.current = window.setTimeout(() => void navigateTo(entry), 470);
    } else void navigateTo(entry);
  };
  const goBack = () => {
    const cursor = navigation.cursor - 1;
    const entry = navigation.entries[cursor];
    if (entry) void navigateTo(entry, { record: false, cursor });
  };
  const goForward = () => {
    const cursor = navigation.cursor + 1;
    const entry = navigation.entries[cursor];
    if (entry) void navigateTo(entry, { record: false, cursor });
  };
  const goHome = () => {
    const homeTopicId = project?.manifest.homeTopicId ?? project?.topics[0]?.id;
    if (homeTopicId) navigateTopic(homeTopicId);
  };
  const openPortal = async (portalId: string) => {
    const portal = projection?.portals.find(({ id }) => id === portalId);
    if (!portal) return;
    if (portal.direction === "incoming") {
      await navigateTo({ kind: "topic", instanceId: portal.sourceInstanceId, projectId: portal.sourceProjectId, topicId: portal.sourceTopicId, keyIssueId: portal.sourceKeyIssueId, label: portal.sourceTopicTitle, projectLabel: portal.projectTitle });
      return;
    }
    const resolution = await libraryApi.resolve(portal.targetProjectId);
    const base = { kind: "topic" as const, projectId: portal.targetProjectId, topicId: portal.targetTopicId ?? "", label: portal.topicTitle ?? portal.projectTitle, projectLabel: portal.projectTitle };
    if (resolution.status === "resolved") {
      await navigateTo({ ...base, instanceId: resolution.project.instanceId, topicId: portal.targetTopicId ?? resolution.project.homeTopicId ?? "" });
    } else if (resolution.status === "choose") setDuplicateChoice({ entry: base, projects: resolution.projects });
    else setUnavailableEntry({ ...base, instanceId: resolution.projects[0]?.instanceId ?? "" });
  };
  const locatePortal = async (portalId: string) => {
    const portal = projection?.portals.find(({ id }) => id === portalId);
    if (!portal) return;
    if (portal.direction === "incoming") {
      const located = await libraryApi.locate(portal.sourceInstanceId);
      if ("cancelled" in located) return;
      await navigateTo({ kind: "topic", instanceId: located.project.instanceId, projectId: portal.sourceProjectId, topicId: portal.sourceTopicId || located.project.homeTopicId || "", keyIssueId: portal.sourceKeyIssueId, label: portal.sourceTopicTitle, projectLabel: located.project.title });
      return;
    }
    const located = await libraryApi.locateProject(portal.targetProjectId);
    if ("cancelled" in located) return;
    const topicId = portal.targetTopicId ?? located.project.homeTopicId ?? "";
    await navigateTo({ kind: "topic", instanceId: located.project.instanceId, projectId: portal.targetProjectId, topicId, label: portal.topicTitle ?? located.project.homeTopicTitle ?? located.project.title, projectLabel: located.project.title });
  };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      event.preventDefault();
      const backward = directionForLocale(locale) === "rtl" ? event.key === "ArrowRight" : event.key === "ArrowLeft";
      if (backward) goBack(); else goForward();
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  });

  const saveEntityText = useCallback(
    async (target: EntityTarget, patch: Partial<StudioText>): Promise<DraftAck<StudioText>> => {
      const result = await runMutation(() =>
        target.kind === "topic" ? api.updateTopic(target.id, patch) : api.updateKeyIssue(target.id, patch),
      undefined, false, true);
      const entity = (target.kind === "topic" ? result.project.topics : result.project.keyIssues).find(({ id }) => id === target.id);
      return { revision: result.project.manifest.revision, values: entity ? { title: entity.title, description: entity.description ?? "" } : {} };
    },
    [api, runMutation]
  );
  const saveProjectText = useCallback(async (patch: Partial<StudioText>): Promise<DraftAck<StudioText>> => {
    const result = await runMutation(() => api.updateProject(patch), undefined, false, true);
    return { revision: result.project.manifest.revision, values: { title: result.project.manifest.title, description: result.project.manifest.description ?? "" } };
  }, [api, runMutation]);

  const openStudio = () => {
    if (!project) return;
    setMode("studio");
    // The checkpoint marks where this editing session began, so Cancel can restore it as one step.
    studioSession.current = {
      startRevision: latestProject.current?.manifest.revision ?? project.manifest.revision,
      checkpoint: enqueue(() => api.checkpoint()).then(({ checkpoint, history }) => {
        setCommandHistory(history);
        return checkpoint;
      }, () => undefined)
    };
  };
  const closeStudio = () => {
    studioFlush.current = undefined;
    setMode("viewer");
    setStudioTitleFocusId(undefined);
    studioSession.current = undefined;
    window.setTimeout(() => document.querySelector<HTMLButtonElement>(".panel-edit")?.focus(), 0);
  };
  const hasSessionChanges = () => Boolean(studioSession.current && latestProject.current && latestProject.current.manifest.revision !== studioSession.current.startRevision);
  const discardStudioSession = async () => {
    const checkpoint = await studioSession.current?.checkpoint;
    if (!checkpoint) throw new Error(t("discardUnavailable"));
    try {
      await runMutation(() => api.revert(checkpoint), undefined, true);
    } catch (error) {
      throw new Error(error instanceof ProjectRequestError && error.code === "checkpoint-unavailable" ? t("discardUnavailable") : t("discardError"), { cause: error });
    }
    setResyncToken((value) => value + 1);
    closeStudio();
  };
  const createStudioTopic = async () => {
    if (studioFlush.current && !await studioFlush.current()) return;
    await transferQueue.current.catch(() => undefined);
    const previousIds = new Set((latestProject.current ?? project)?.topics.map(({ id }) => id));
    const result = await runMutation(() => api.createTopic({ title: t("untitledTopic") }));
    const added = result.project.topics.find(({ id }) => !previousIds.has(id));
    if (!added) return;
    const instanceId = result.instanceId ?? activeInstanceId;
    if (instanceId) await navigateTo({ kind: "topic", instanceId, projectId: result.project.manifest.id, topicId: added.id, label: added.title, projectLabel: result.project.manifest.title }, { force: true, stayInStudio: true });
    setStudioTitleFocusId(added.id);
    showNotice(t("topicAdded"));
  };
  const coverError = (error: unknown) => error instanceof ProjectRequestError && error.code === "unsupported-cover" ? new Error(t("coverTypeError")) : error;
  const studioCover = (target: KnowledgeContextTarget): StudioCover => {
    const entity = target.kind === "topic" ? project?.topics.find(({ id }) => id === target.id) : project?.keyIssues.find(({ id }) => id === target.id);
    const own = imageHrefFor(entity?.visualAssetId);
    if (own || target.kind === "topic") return { url: own, own: Boolean(own), inherited: false };
    return { url: centralCoverImageUrl, own: false, inherited: Boolean(centralCoverImageUrl) };
  };
  const deleteContext = async () => {
    if (!contextTarget || !projection) return;
    const target = contextTarget;
    const topicId = projection.centralTopic.id;
    await runMutation(() => target.kind === "topic" ? api.deleteTopic(target.id) : api.deleteKeyIssue(target.id), t("deleteError"));
    setPreviousProjection(undefined);
    clearSelection();
    setMode("viewer");
    setFocusToken((value) => value + 1);
    window.setTimeout(() => (document.querySelector<HTMLButtonElement>(".panel-edit") ?? searchButton.current)?.focus(), 0);
    showNotice(t(target.kind === "topic" ? "topicDeleted" : "keyIssueDeleted"), async () => {
      await undoRedo("undo");
      setCentralTopicId(topicId);
      if (target.kind === "keyIssue") setSelectedKeyIssueId(target.id);
      setFocusToken((value) => value + 1);
      setNotice(undefined);
    });
  };

  const addTopic = async () => {
    if (!project || topicBusy || !topicTitle.trim()) return;
    const previousIds = new Set(project.topics.map(({ id }) => id));
    setTopicBusy(true);
    setTopicError("");
    try {
      const result = await runMutation(() => api.createTopic({ title: topicTitle.trim() }));
      const added = result.project.topics.find(({ id }) => !previousIds.has(id));
      const destination = added ?? result.project.topics.find(({ id }) => id === result.project.manifest.homeTopicId) ?? result.project.topics[0];
      const instanceId = result.instanceId ?? activeInstanceId;
      if (destination && instanceId) await navigateTo({ kind: "topic", instanceId, projectId: result.project.manifest.id, topicId: destination.id, label: destination.title, projectLabel: result.project.manifest.title }, { force: true });
      setTopicTitle("");
      setAddTopicOpen(false);
      setSettingsOpen(false);
      showNotice(t("topicAdded"), async () => {
        await undoRedo("undo");
        setNotice(undefined);
      });
    } catch (caught) {
      setTopicError(caught instanceof Error ? caught.message : t("saveError"));
    } finally {
      setTopicBusy(false);
    }
  };

  const runTransfer = (action: TransferAction, operation: () => Promise<void>, onError: (message: string) => void) => {
    const task = (async () => {
      setTransferBusy(true);
      setTransferAction(action);
      try { await operation(); }
      catch (error) { onError(error instanceof Error && error.message ? error.message : t("transferError")); }
      finally { setTransferBusy(false); setTransferAction(undefined); }
    })();
    transferQueue.current = task;
    return task;
  };
  const transferNotice = (message: string) => showNotice(message, undefined, "error");
  const exportProject = () => runTransfer("export", async () => {
    if (studioFlush.current && !await studioFlush.current()) return;
    await mutationQueue.current.catch(() => undefined);
    const links = await transferApi.exportProject();
    showNotice(links ? `${t("exportReady")} ${t("exportLinksNotice").replace("{count}", new Intl.NumberFormat(locale).format(links))}` : t("exportReady"));
    setSettingsOpen(false);
  }, transferNotice);
  const previewImport = (file: File) => {
    if (!file.name.toLocaleLowerCase("en-US").endsWith(".outmapper")) {
      setPackageError(t("packageTypeError"));
      return Promise.resolve();
    }
    return runTransfer("preview", async () => {
    setPackageError("");
    setPackageProgress(undefined);
    const plan = await transferApi.previewImport(file, setPackageProgress);
    setPackagePickerOpen(false);
    setImportPlan(plan);
    setImportDirectory(plan.suggestedDirectoryName);
    setImportMode("copy");
  }, setPackageError);
  };
  const closeImport = () => runTransfer("cancel", async () => {
    if (!importPlan) return;
    await transferApi.cancelImport(importPlan.id);
    setImportPlan(undefined);
    restoreImportFocus();
  }, transferNotice);
  const commitImport = () => runTransfer("commit", async () => {
    if (!importPlan) return;
    if (studioFlush.current && !await studioFlush.current()) return;
    await mutationQueue.current.catch(() => undefined);
    const result = await transferApi.commitImport(importPlan.id, importDirectory, importMode);
    setImportPlan(undefined);
    if (result.project && result.history && result.instanceId) {
      const topic = result.project.topics.find(({ id }) => id === result.project!.manifest.homeTopicId) ?? result.project.topics[0];
      if (topic) await navigateTo({ kind: "topic", instanceId: result.instanceId, projectId: result.project.manifest.id, topicId: topic.id, label: topic.title, projectLabel: result.project.manifest.title }, { activated: { project: result.project, history: result.history, instanceId: result.instanceId, historyCleared: result.historyCleared }, force: true, skipTransferWait: true });
    }
    showNotice(`${t("importedTo")} ${result.projectDirectory}`);
    restoreImportFocus();
  }, transferNotice);
  const closeSearch = () => {
    setSearchOpen(false);
    window.setTimeout(() => searchButton.current?.focus(), 0);
  };
  const openSearch = () => {
    setSettingsOpen(false);
    setLanguageOpen(false);
    setHistoryOpen(false);
    setSelectedRelatedTopicId(undefined);
    setSearchText("");
    setSearchOpen(true);
  };
  const activateSearchHit = async (hit: SearchHit) => {
    const context = hit.contexts[0];
    const targetTopicId = hit.kind === "topic" ? hit.id : context?.topicId;
    const topic = project?.topics.find(({ id }) => id === targetTopicId);
    const instanceId = hit.sourceInstanceId ?? activeInstanceId;
    const projectId = hit.sourceProjectId ?? project?.manifest.id;
    const projectLabel = hit.sourceProjectTitle ?? project?.manifest.title;
    if (targetTopicId && instanceId && projectId && projectLabel) await navigateTo({ kind: "topic", instanceId, projectId, topicId: targetTopicId, ...(hit.kind === "keyIssue" || context?.keyIssueId ? { keyIssueId: hit.kind === "keyIssue" ? hit.id : context?.keyIssueId } : {}), label: topic?.title ?? hit.title, projectLabel });
    setRelationshipsOpen(false);
    setSettingsOpen(false);
    setHistoryOpen(false);
    setMode("viewer");
    setMobileView(hit.kind === "knowledgeItem" ? "knowledge" : "map");
    setSearchOpen(false);
    setFocusToken((value) => value + 1);
    window.setTimeout(() => {
      if (hit.kind === "knowledgeItem") {
        document.querySelector<HTMLElement>(".knowledge-panel h1")?.focus();
      } else {
        document.querySelector<HTMLElement>(`[data-entity-id="${hit.id}"]`)?.focus();
      }
    }, 0);
  };
  const loadMoreSearch = async () => {
    if (!(searchScope === "workspace" ? searchPage.continuation : searchPage.nextCursor)) return;
    setSearchBusy(true);
    try {
      const next = await search({
        text: searchText,
        scope: searchScope,
        match: "prefix",
        filters: searchKind === "all" ? undefined : { entityKinds: [searchKind] },
        limit: 20,
        ...(searchScope === "workspace" ? { continuation: searchPage.continuation } : { cursor: searchPage.nextCursor })
      });
      setSearchPage((current) => ({
        ...next,
        items: [...current.items, ...next.items.map((hit) => localizeSearchHit(hit, locale, project?.manifest.id))].slice(0, 50),
        total: Math.min(50, current.total + next.total),
        ...(current.totalCapped || next.totalCapped || current.total + next.total > 50 ? { totalCapped: true } : {}),
        notSearchableCount: (current.notSearchableCount ?? 0) + (next.notSearchableCount ?? 0),
        staleProjectCount: (current.staleProjectCount ?? 0) + (next.staleProjectCount ?? 0)
      }));
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : t("searchError"));
    } finally {
      setSearchBusy(false);
    }
  };

  const loadUniverse = useCallback(async () => {
    setUniverseBusy(true);
    setUniverseError(undefined);
    try {
      const result = libraryApi.universe ? await libraryApi.universe() : { nodes: [], edges: [] };
      setUniverse(result);
      setSelectedUniverseProjectId((current) => current && result.nodes.some(({ projectId }) => projectId === current) ? current : undefined);
      const workspace = await libraryApi.workspace();
      updateWorkspace(Object.values(workspace.projects), workspace.activeInstanceId);
    } catch (error) {
      setUniverseError(error instanceof Error ? error.message : t("universeError"));
    } finally {
      setUniverseBusy(false);
    }
  }, [libraryApi, t, updateWorkspace]);

  useEffect(() => {
    if (currentView !== "universe") return;
    const timer = window.setTimeout(() => void loadUniverse(), 0);
    return () => window.clearTimeout(timer);
  }, [currentView, loadUniverse]);

  const selectedUniverseNode = universe?.nodes.find(({ projectId }) => projectId === selectedUniverseProjectId);
  const universePanelNode = selectedUniverseNode ?? universe?.nodes.find(({ projectId }) => projectId === project?.manifest.id);
  const openUniverseProject = async (node: UniverseProjectNode) => {
    try {
      const result = await libraryApi.activate(node.instanceId);
      const topic = result.project.topics.find(({ id }) => id === node.homeTopicId) ?? result.project.topics.find(({ id }) => id === result.project.manifest.homeTopicId) ?? result.project.topics[0];
      if (topic && result.instanceId) await navigateTo({ kind: "topic", instanceId: result.instanceId, projectId: result.project.manifest.id, topicId: topic.id, label: topic.title, projectLabel: result.project.manifest.title }, { activated: result, force: true });
      else activateProject(result);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : t("projectUnavailable"), undefined, "error");
    }
  };
  const locateUniverseProject = async (node: UniverseProjectNode) => {
    try {
      const result = await libraryApi.locate(node.instanceId);
      if (!("cancelled" in result)) await loadUniverse();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : t("projectUnavailable"), undefined, "error");
    }
  };
  const removeUniverseProjectFromRecent = async (node: UniverseProjectNode) => {
    try {
      await libraryApi.removeFromRecent(node.instanceId);
      await loadUniverse();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : t("projectUnavailable"), undefined, "error");
    }
  };
  const forgetUniverseProject = async () => {
    if (!universeForget) return;
    setUniverseBusy(true);
    try {
      await libraryApi.forget(universeForget.instanceId);
      setUniverseForget(undefined);
      setSelectedUniverseProjectId(undefined);
      await loadUniverse();
      setFocusToken((value) => value + 1);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : t("projectUnavailable"), undefined, "error");
      setUniverseBusy(false);
    }
  };

  const visibleSearchPage: SearchPage = searchResultText === searchText && searchResultScope === searchScope ? searchPage : { items: [], total: 0 };
  // Newest first. A Project name is added only for places in another Project, and never when it repeats the Topic title.
  // Places in the open Project use its displayed (localized) Topic title; others keep the title recorded on the visit.
  const historyEntries: Array<{ entry: NavEntry; index: number; label: string; projectHint?: string }> = navigation.entries.map((entry, index) => {
    if (entry.kind === "universe") return { entry, index, label: t("universe") };
    const current = entry.instanceId === activeInstanceId;
    const label = (current ? displayProject?.topics.find(({ id }) => id === entry.topicId)?.title : undefined) ?? entry.label;
    const projectHint = !current && entry.projectLabel.trim().toLocaleLowerCase(locale) !== label.trim().toLocaleLowerCase(locale) ? entry.projectLabel : undefined;
    return { entry, index, label, ...(projectHint ? { projectHint } : {}) };
  }).reverse();
  const universeLabels: UniverseLabels = {
    mapLabel: t("universeRegion"),
    loading: t("loadingUniverse"),
    empty: t("emptyUniverse"),
    single: t("universeSingle"),
    error: t("universeError"),
    retry: t("retry"),
    zoomIn: t("zoomIn"),
    zoomOut: t("zoomOut"),
    closePreview: t("closePreview"),
    project: t("project"),
    currentProject: t("currentProject"),
    openProject: t("openProjectAction"),
    projectActions: t("projectActions"),
    removeFromRecent: t("removeFromRecent"),
    forgetProject: t("forgetProject"),
    locate: t("locate"),
    noDescription: t("noDescription"),
    noLinks: t("universeNoLinks"),
    outgoing: t("universeOutgoing"),
    incoming: t("universeIncoming"),
    copies: t("universeCopies"),
    links: t("universeLinks"),
    linkedProjects: t("linkedProjects"),
    outgoingHeading: t("portalOutgoing"),
    incomingHeading: t("portalIncoming"),
    statuses: {
      missing: t("projectMissing"),
      mismatch: t("projectFolderChanged"),
      unreadable: t("projectUnavailable"),
      "needs-open": t("projectNeedsOpen")
    }
  };

  return (
    <div className="app" data-mobile-view={mobileView} data-mode={mode} data-view={currentView}>
      <header className="app-bar">
        <div className="app-bar__start">
          <button ref={searchButton} className="tool" type="button" aria-label={t("search")} data-tooltip={t("search")} data-tooltip-side="bottom" data-tooltip-align="start" aria-haspopup="dialog" onClick={openSearch}><Icon name="search" /></button>
          <button className="tool" type="button" aria-label={t("universe")} data-tooltip={t("universe")} data-tooltip-side="bottom" data-tooltip-align="start" aria-pressed={currentView === "universe"} onClick={() => {
            setSettingsOpen(false);
            setHistoryOpen(false);
            // A toggle: pressed again, it returns to the place the Universe was opened from.
            if (currentView !== "universe") void navigateTo({ kind: "universe" });
            else if (navigation.cursor > 0) goBack();
            else goHome();
          }}><Icon name="universe" /></button>
        </div>
        <div className="brand" data-loading={!project && !loadError ? "true" : undefined} aria-label={t("appName")}><span className="brand-mark-frame"><img className="brand-mark" src={theme === "dark" ? "/brand/outmapper-mark-light.svg" : "/brand/outmapper-mark-dark.svg"} alt="" /></span><span className="brand-name">{t("appName")}</span></div>
        <div className="settings-wrap">
          <button ref={settingsButton} className="tool" type="button" aria-label={t("settings")} data-tooltip={t("settings")} data-tooltip-side="bottom" data-tooltip-align="end" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => {
            setSettingsOpen((open) => !open);
            setLanguageOpen(false);
            setHistoryOpen(false);
            setSelectedRelatedTopicId(undefined);
          }}><Icon name="settings" /></button>
          {settingsOpen ? (
            <section ref={settingsPopover} className="settings-popover" role="dialog" aria-label={t("settings")} onBlur={(event) => {
              const next = event.relatedTarget;
              if (!(next instanceof Element) || event.currentTarget.contains(next) || settingsButton.current?.contains(next) || next.closest("dialog[open], .dialog-scrim")) return;
              setSettingsOpen(false);
              setLanguageOpen(false);
            }}>
              <ProjectMenu api={libraryApi} locale={locale} t={t} disabled={transferBusy || saveState === "saving"} onBeforeSwitch={async () => {
                if (transferBusy || saveState === "saving") return false;
                if (studioFlush.current && !await studioFlush.current()) return false;
                await mutationQueue.current.catch(() => undefined);
                return true;
              }} onWorkspace={updateWorkspace} onUniverse={() => void navigateTo({ kind: "universe" })} onProject={(result, created) => {
                const topic = result.project.topics.find(({ id }) => id === result.project.manifest.homeTopicId) ?? result.project.topics[0];
                // An empty Project has no Topic to navigate to, so it is activated directly and shows the empty map.
                if (topic && result.instanceId) void navigateTo({ kind: "topic", instanceId: result.instanceId, projectId: result.project.manifest.id, topicId: topic.id, label: topic.title, projectLabel: result.project.manifest.title }, { activated: result, force: true });
                else activateProject(result);
                if (created) showNotice(t("projectCreated"));
              }}>
                <button ref={importButton} type="button" className="popover-action" aria-haspopup="dialog" disabled={transferBusy || saveState === "saving"} onClick={() => { setPackageError(""); setPackagePickerOpen(true); }}><Icon name="package" /><span>{t("importPackage")}</span></button>
              </ProjectMenu>
              <section className="settings-section settings-section--current" aria-labelledby="settings-current-heading">
                <p className="settings-current__label">{t("currentProject")}</p>
                <h2 id="settings-current-heading" className="settings-current__title" dir="auto">{displayProject?.manifest.title ?? project?.manifest.title ?? t("loadingMap")}</h2>
                <div className="settings-action-group">
                  <button type="button" className="popover-action" aria-haspopup="dialog" disabled={!project || transferBusy} onClick={() => setProjectSettingsOpen(true)}><Icon name="edit" /><span>{t("projectSettings")}</span></button>
                  <button type="button" className="popover-action" aria-busy={transferAction === "export"} disabled={transferBusy || saveState === "saving"} onClick={() => void exportProject()}>{transferAction === "export" ? <Spinner /> : <Icon name="download" />}<span>{transferAction === "export" ? t("exportingPackage") : t("exportPackage")}</span></button>
                </div>
              </section>
              <div className="settings-preferences">
              <div className="settings-section settings-section--language">
              <h2>{t("language")}</h2>
              <div ref={languageSelect} className="language-select">
                <button
                  ref={languageButton}
                  className="language-trigger"
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={languageOpen}
                  aria-label={`${t("language")}: ${localeNames[locale]}`}
                  onClick={() => setLanguageOpen((open) => !open)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      setLanguageOpen(true);
                      window.setTimeout(() => languageOptions.current[(Object.keys(localeNames) as Locale[]).indexOf(locale)]?.focus(), 0);
                    }
                  }}
                >
                  <span lang={locale}>{localeNames[locale]}</span><Icon name="chevronDown" />
                </button>
                {languageOpen ? (
                  <div className="language-menu" role="listbox" aria-label={t("language")}>
                    {(Object.keys(localeNames) as Locale[]).map((value, index, values) => (
                      <button
                        ref={(element) => { languageOptions.current[index] = element; }}
                        type="button"
                        role="option"
                        aria-selected={locale === value}
                        onClick={() => {
                          setLocale(value);
                          setLanguageOpen(false);
                          window.setTimeout(() => languageButton.current?.focus(), 0);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                            event.preventDefault();
                            const offset = event.key === "ArrowDown" ? 1 : -1;
                            languageOptions.current[(index + offset + values.length) % values.length]?.focus();
                          } else if (event.key === "Home" || event.key === "End") {
                            event.preventDefault();
                            languageOptions.current[event.key === "Home" ? 0 : values.length - 1]?.focus();
                          }
                        }}
                        key={value}
                      >
                        <span lang={value}>{localeNames[value]}</span><Icon name="check" />
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              </div>
              <div className="settings-section settings-section--appearance">
              <h2>{t("appearance")}</h2>
              <div className="segmented">{(["light", "dark"] as const).map((value) => <button type="button" aria-pressed={theme === value} onClick={() => setTheme(value)} key={value}><Icon name={value === "light" ? "sun" : "moon"} />{t(value)}</button>)}</div>
              </div>
              </div>
              <p className="app-version">{t("appName")} {APPLICATION_VERSION}</p>
            </section>
          ) : null}
        </div>
      </header>
      {currentView === "universe" ? <main className={`workspace universe-workspace ${panelOpen ? "" : "is-panel-closed"}`}>
        <section className="map-stage universe-stage" aria-label={t("universeRegion")}>
          <UniverseView
            universe={universe}
            loading={universeBusy}
            error={universeError}
            currentProjectId={project?.manifest.id}
            selectedProjectId={selectedUniverseProjectId}
            focusToken={focusToken}
            labels={universeLabels}
            locale={locale}
            direction={directionForLocale(locale)}
            onRetry={() => void loadUniverse()}
            onSelect={setSelectedUniverseProjectId}
            onOpen={(projectId) => { const node = universe?.nodes.find((entry) => entry.projectId === projectId); if (node) void openUniverseProject(node); }}
          />
          <div className="map-actions" role="toolbar">
            <div className="capsule">
              <button className="tool" type="button" aria-label={t("back")} data-tooltip={t("back")} data-tooltip-side="bottom" data-tooltip-align="start" disabled={navigation.cursor <= 0} onClick={goBack}><Icon name="back" /></button>
              <button className="tool" type="button" aria-label={t("forward")} data-tooltip={t("forward")} data-tooltip-side="bottom" disabled={navigation.cursor >= navigation.entries.length - 1} onClick={goForward}><Icon name="chevronRight" /></button>
              <button className="tool" type="button" aria-label={t("home")} data-tooltip={t("home")} data-tooltip-side="bottom" data-tooltip-align="start" onClick={goHome}><Icon name="home" /></button>
            </div>
          </div>
          <div className="history-control">
            <button ref={historyButton} className="pill history-trigger" type="button" aria-label={t("history")} aria-haspopup="menu" aria-expanded={historyOpen} onClick={() => { setHistoryOpen((open) => !open); setSettingsOpen(false); setLanguageOpen(false); }}><Icon name="clock" /><span>{t("history")}</span><Icon name="chevronDown" /></button>
            {historyOpen ? <div ref={historyPopover} className="history-popover" role="menu" aria-label={t("history")} dir={directionForLocale(locale)} onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              event.preventDefault();
              items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
            }}>{historyEntries.length ? historyEntries.map(({ entry, index, label, projectHint }) => <button type="button" role="menuitem" aria-current={index === navigation.cursor ? "location" : undefined} key={`${entry.kind === "universe" ? "universe" : `${entry.instanceId}:${entry.topicId}`}:${index}`} onClick={() => void navigateTo(entry, { record: false, cursor: index })}><span className="history-entry__title" dir="auto">{label}</span>{projectHint ? <small dir="auto">{projectHint}</small> : null}</button>) : <p className="history-empty">{t("noHistory")}</p>}</div> : null}
          </div>
          {universe && universe.nodes.length > 1 ? <button type="button" className="panel-toggle pill" aria-expanded={panelOpen} onClick={() => setPanelOpen((open) => !open)}><Icon name="panel" /><span>{panelOpen ? t("hidePanel") : t("showPanel")}</span></button> : null}
        </section>
        {/* The selected Project, or the current one, in the same collapsible side panel as Knowledge. */}
        {universePanelNode && universe && universe.nodes.length > 1 ? <aside className="knowledge-panel universe-side-panel" dir="ltr" aria-label={universePanelNode.title}>
          <div className="knowledge-panel__content" dir={directionForLocale(locale)}>
            <UniverseProjectPanel
              key={universePanelNode.projectId}
              node={universePanelNode}
              universe={universe}
              labels={universeLabels}
              locale={locale}
              direction={directionForLocale(locale)}
              current={universePanelNode.projectId === project?.manifest.id}
              active={universePanelNode.instanceId === activeInstanceId}
              onOpen={() => void openUniverseProject(universePanelNode)}
              onRemoveFromRecent={() => void removeUniverseProjectFromRecent(universePanelNode)}
              onForget={() => setUniverseForget(universePanelNode)}
              onLocate={() => void locateUniverseProject(universePanelNode)}
              onSelectProject={(projectId) => setSelectedUniverseProjectId(projectId)}
              onOpenProject={(projectId) => { const node = universe.nodes.find((entry) => entry.projectId === projectId); if (node) void openUniverseProject(node); }}
            />
          </div>
        </aside> : null}
      </main> : <main className={`workspace ${panelOpen ? "" : "is-panel-closed"}`}>
        <section className="map-stage" aria-label={t("mapRegion")}>
          {projection && mapReady ? (
            <>
              <MapViewer key={projection.centralTopic.id} projection={projection} direction={directionForLocale(locale)} coverImageUrl={centralCoverImageUrl} focusToken={focusToken} transitioningTopicId={transitioningTopicId} labels={{ mapLabel: `${t("mapRegion")}: ${projection.centralTopic.title}`, centralTopic: t("centralTopic"), keyIssue: t("keyIssue"), relatedTopic: t("relatedTopic"), connectedVia: t("connectedVia"), linkedProject: t("linkedProject"), incomingLinkFrom: t("incomingLinkFrom"), projectOverflow: t("projectOverflow"), zoomIn: t("zoomIn"), zoomOut: t("zoomOut") }} onSelectKeyIssue={selectKeyIssue} onSelectRelatedTopic={navigateTopic} onSelectPortal={(id) => { setSelectedPortalId(id); setSelectedRelatedTopicId(undefined); }} selectedPortalId={selectedPortalId} onShowPortalOverflow={() => setPortalOverflowOpen(true)} onClearSelection={clearSelection} />
              <div className="map-actions" role="toolbar">
                <div className="capsule">
                  <button className="tool" type="button" aria-label={t("back")} data-tooltip={t("back")} data-tooltip-side="bottom" data-tooltip-align="start" aria-keyshortcuts="Alt+ArrowLeft" disabled={navigation.cursor <= 0} onClick={goBack}><Icon name="back" /></button>
                  <button className="tool" type="button" aria-label={t("forward")} data-tooltip={t("forward")} data-tooltip-side="bottom" disabled={navigation.cursor >= navigation.entries.length - 1} onClick={goForward}><Icon name="chevronRight" /></button>
                  <button className="tool" type="button" aria-label={t("home")} data-tooltip={t("home")} data-tooltip-side="bottom" data-tooltip-align="start" onClick={goHome}><Icon name="home" /></button>
                  <button className="tool" type="button" aria-label={t("relationshipsList")} data-tooltip={t("relationshipsList")} data-tooltip-side="bottom" data-tooltip-align="start" aria-pressed={relationshipsOpen} onClick={() => {
                    setRelationshipsOpen((open) => !open);
                    setSelectedRelatedTopicId(undefined);
                    setHistoryOpen(false);
                  }}><Icon name="list" /></button>
                </div>
              </div>
              <div className="history-control">
                <button ref={historyButton} className="pill history-trigger" type="button" aria-label={t("history")} aria-haspopup="menu" aria-expanded={historyOpen} onClick={() => {
                  setHistoryOpen((open) => !open);
                  setSettingsOpen(false);
                  setLanguageOpen(false);
                }}><Icon name="clock" /><span>{t("history")}</span><Icon name="chevronDown" /></button>
                {historyOpen ? <div ref={historyPopover} className="history-popover" role="menu" aria-label={t("history")} dir={directionForLocale(locale)} onKeyDown={(event) => {
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
                  const index = items.indexOf(document.activeElement as HTMLButtonElement);
                  event.preventDefault();
                  items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
                }}>{historyEntries.length ? historyEntries.map(({ entry, index, label, projectHint }) => <button type="button" role="menuitem" aria-current={index === navigation.cursor ? "location" : undefined} key={`${entry.kind === "universe" ? "universe" : `${entry.instanceId}:${entry.topicId}`}:${index}`} onClick={() => void navigateTo(entry, { record: false, cursor: index })}><span className="history-entry__title" dir="auto">{label}</span>{projectHint ? <small dir="auto">{projectHint}</small> : null}</button>) : <p className="history-empty">{t("noHistory")}</p>}</div> : null}
              </div>
              {relationshipsOpen ? <RelationshipNavigator projection={projection} title={t("relationshipsList")} alsoViaLabel={t("alsoVia")} onSelectKeyIssue={selectKeyIssue} onSelectRelatedTopic={selectRelatedTopic} /> : null}
              {selectedRelatedTopic && !transitioningTopicId ? (
                <section className="topic-preview" aria-label={`${t("relatedTopic")}: ${selectedRelatedTopic.title}`} dir={directionForLocale(locale)}>
                  <button type="button" className="tool topic-preview__close" aria-label={t("closePreview")} data-tooltip={t("closePreview")} data-tooltip-side="bottom" data-tooltip-align="end" onClick={() => {
                    const topicId = selectedRelatedTopic.id;
                    setSelectedRelatedTopicId(undefined);
                    window.setTimeout(() => [...document.querySelectorAll<HTMLButtonElement>("[data-entity-id]")].find((node) => node.dataset.entityId === topicId)?.focus(), 0);
                  }}><Icon name="close" /></button>
                  <p className="eyebrow">{t("relatedTopic")} · {t("connectedVia")} {connectedIssueTitles?.join(" · ")}</p>
                  <h2 dir="auto">{selectedRelatedTopic.title}</h2>
                  <p dir="auto">{selectedRelatedTopic.description ?? t("noDescription")}</p>
                  <button className="pill pill--accent" type="button" onClick={() => navigateTopic(selectedRelatedTopic.id)}>{t("openTopic")}</button>
                </section>
              ) : null}
              {selectedPortal ? (
                <section className="topic-preview portal-preview" aria-label={`${selectedPortal.direction === "incoming" ? t("incomingLinkFrom") : t("linkedProject")}: ${selectedPortal.projectTitle}`} dir={directionForLocale(locale)}>
                  <button type="button" className="tool topic-preview__close" aria-label={t("closePreview")} data-tooltip={t("closePreview")} data-tooltip-side="bottom" data-tooltip-align="end" onClick={() => {
                    const portalId = selectedPortal.id;
                    setSelectedPortalId(undefined);
                    window.setTimeout(() => [...document.querySelectorAll<HTMLButtonElement>("[data-entity-id]")].find((node) => node.dataset.entityId === portalId)?.focus(), 0);
                  }}><Icon name="close" /></button>
                  {/* Direction, Project, and one quiet line for the route; a note only when the link has one. */}
                  <p className="eyebrow portal-preview__eyebrow"><Icon name="package" />{t(selectedPortal.direction === "incoming" ? "portalIncoming" : "portalOutgoing")}</p>
                  <h2 dir="auto">{selectedPortal.projectTitle}</h2>
                  <p className="portal-preview__route"><span>{t("connectedVia")}</span> <bdi>{selectedPortal.direction === "incoming"
                    ? [unique(selectedPortalLinks.flatMap((link) => link.direction === "incoming" ? [link.sourceTopicTitle] : [])), unique(selectedPortalLinks.flatMap((link) => link.direction === "incoming" ? [link.sourceKeyIssueTitle] : []))].join(" · ")
                    : unique(selectedPortalLinks.flatMap((link) => link.direction === "outgoing" ? [link.keyIssueTitle] : []))}</bdi></p>
                  {selectedPortal.direction === "outgoing" && selectedPortalLinks.some((link) => link.direction === "outgoing" && link.topicTitle) ? <p className="portal-preview__topic"><Icon name="open" /><span dir="auto">{unique(selectedPortalLinks.flatMap((link) => link.direction === "outgoing" && link.topicTitle ? [link.topicTitle] : []))}</span></p> : null}
                  {selectedPortal.availability !== "available"
                    ? <p className="portal-preview__note">{t("projectUnavailable")}</p>
                    : selectedPortal.direction === "outgoing" && selectedPortal.note ? <p className="portal-preview__note" dir="auto">{selectedPortal.note}</p> : null}
                  {selectedPortal.availability === "available"
                    ? <button className="pill pill--accent" type="button" onClick={() => void openPortal(selectedPortal.id)}>{t("openProjectAction")}</button>
                    : <button className="pill pill--accent" type="button" onClick={() => void locatePortal(selectedPortal.id)}><Icon name="folder" />{t("locate")}</button>}
                </section>
              ) : null}
              <button type="button" className="panel-toggle pill" aria-expanded={panelOpen} onClick={() => setPanelOpen((open) => !open)}><Icon name="panel" /><span>{panelOpen ? t("hidePanel") : t("showPanel")}</span></button>
            </>
          ) : (
            <div className="empty-region" data-loading={mapLoading ? "true" : undefined} role={loadError ? "alert" : "status"}>
              <span className="empty-orbit" aria-hidden="true"><img className="empty-orbit__mark" src={theme === "dark" ? "/brand/outmapper-mark-light.svg" : "/brand/outmapper-mark-dark.svg"} alt="" /></span>
              <div className="empty-region__copy">
              <p>{loadError ? t("loadError") : mapLoading ? t("loadingMap") : t("emptyMap")}</p>
              {loadError ? <button className="pill" type="button" onClick={() => { setLoadError(false); setLoadAttempt((attempt) => attempt + 1); }}>{t("retry")}</button> : !mapLoading ? <div className="empty-region__actions">
                <button className="pill pill--accent" type="button" onClick={() => { setTopicError(""); setAddTopicOpen(true); }}><Icon name="plus" />{t("addTopic")}</button>
                {commandHistory.canUndo ? <button className="pill" type="button" disabled={saveState === "saving"} onClick={() => void undoRedo("undo").catch(() => {})}>{t("undo")}</button> : null}
              </div> : null}
              </div>
            </div>
          )}
        </section>
        <aside ref={knowledgePanel} className="knowledge-panel" dir="ltr" aria-label={t("knowledgeRegion")}>
          <div className="knowledge-panel__content" dir={directionForLocale(locale)}>
          {mode === "studio" && project && projection && contextTarget ? (
            <StudioPanel
              key={`${contextTarget.kind}:${contextTarget.id}`}
              project={project}
              displayTopics={displayProject?.topics}
              projection={projection}
              target={contextTarget}
              t={t}
              locale={locale}
              saveState={saveState}
              history={commandHistory}
              resyncToken={resyncToken}
              cover={studioCover(contextTarget)}
              isHomeTopic={contextTarget.kind === "topic" && project.manifest.homeTopicId === contextTarget.id}
              focusTitle={studioTitleFocusId === contextTarget.id}
              onSave={(patch) => saveEntityText(contextTarget, patch)}
              onFlushReady={(flush) => { studioFlush.current = flush; }}
              onClose={closeStudio}
              hasSessionChanges={hasSessionChanges}
              onDiscard={discardStudioSession}
              onDelete={deleteContext}
              onUndo={() => undoRedo("undo")}
              onRedo={() => undoRedo("redo")}
              onNewTopic={createStudioTopic}
              onSetHomeTopic={async () => {
                await runMutation(() => api.updateProject({ homeTopicId: contextTarget.id }));
                showNotice(t("homeTopicUpdated"));
              }}
              onSetCover={async (file, onProgress) => {
                try {
                  await runMutation(() => assetApi.setCover(file, contextTarget, onProgress), undefined, true);
                } catch (error) {
                  throw coverError(error);
                }
                showNotice(t("coverUpdated"));
              }}
              onRemoveCover={async () => {
                await runMutation(() => assetApi.removeCover(contextTarget));
                showNotice(t("coverRemoved"), async () => {
                  await undoRedo("undo");
                  setNotice(undefined);
                });
              }}
              onImportFolder={() => setFolderImportOpen(true)}
              onAddKeyIssue={async (title) => { await runMutation(() => api.createKeyIssue({ topicId: projection.centralTopic.id, title })); }}
              onReorderKeyIssues={async (ids) => { await runMutation(() => api.reorderKeyIssues(projection.centralTopic.id, ids)); }}
              onAddRelationship={async (targetTopicId) => {
                if (contextTarget.kind !== "keyIssue") return;
                await runMutation(() => api.connectTopics({ sourceTopicId: projection.centralTopic.id, keyIssueId: contextTarget.id, targetTopicId }));
                showNotice(t("topicLinked"));
              }}
              onCreateRelationshipTopic={async (title) => {
                if (contextTarget.kind !== "keyIssue") return;
                await runMutation(() => api.createAndConnectTopic({ sourceTopicId: projection.centralTopic.id, keyIssueId: contextTarget.id, title }));
                showNotice(t("topicLinked"), async () => {
                  await undoRedo("undo");
                  setNotice(undefined);
                });
              }}
              onRemoveRelationship={async (relationshipId) => { await runMutation(() => api.disconnectRelationship(relationshipId)); }}
              onRemoveProjectLink={async (projectLinkId) => { await runMutation(() => api.unlinkProject(projectLinkId)); }}
              onReorderTargets={async (ids) => { if (contextTarget.kind !== "keyIssue") return; await runMutation(() => api.reorderKeyIssueTargets(contextTarget.id, ids)); }}
              onOpenProjectLink={() => { if (contextTarget.kind === "keyIssue") setProjectLinkIssueId(contextTarget.id); }}
              onAddKnowledge={async (input) => {
                await runMutation(() => api.createKnowledge({ ...input, targetKind: contextTarget.kind, targetId: contextTarget.id }), t("knowledgeAddError"));
                showNotice(t("knowledgeAdded"));
                window.requestAnimationFrame(() => {
                  if (document.activeElement === document.body) document.querySelector<HTMLInputElement>(".knowledge-form input[name='knowledgeTitle']")?.focus();
                });
              }}
              onAttachAsset={async (file, onProgress) => {
                await runMutation(() => assetApi.attachAsset(file, contextTarget, onProgress), undefined, true);
              }}
              onAttachComplete={({ files, attached, failed }) => {
                const number = new Intl.NumberFormat(locale);
                if (files.length === 1) {
                  if (attached) showNotice(`${t("fileAttached")}: ${files[0]!.name}`);
                } else if (failed) {
                  showNotice(t("filesAttachedWithFailures").replace("{attached}", number.format(attached)).replace("{failed}", number.format(failed)), undefined, "error");
                } else {
                  showNotice(t("filesAttached").replace("{count}", number.format(attached)));
                }
              }}
            />
          ) : (
            <KnowledgePanel context={knowledgeContext} badge={knowledgeContext?.target.kind === "topic" && knowledgeContext.target.id === project?.manifest.homeTopicId ? t("homeTopic") : undefined} coverImageUrl={imageHrefFor(knowledgeContext?.entity.visualAssetId) ?? centralCoverImageUrl} locale={locale} assets={project?.assets ?? []} onEdit={openStudio} onTogglePin={async (associationId, pinned) => { await runMutation(() => api.updateKnowledgeAssociation(associationId, { pinned })); }} onEditKnowledge={(associationId) => setKnowledgeEditor({ associationId, removing: false })} onRemoveKnowledge={(associationId) => setKnowledgeEditor({ associationId, removing: true })} labels={{ topic: t("centralTopic"), keyIssue: t("keyIssue"), edit: t("edit"), knowledge: t("knowledge"), noDescription: t("noDescription"), emptySection: t("emptySection"), local: t("local"), external: t("external"), pinned: t("pinned"), publications: t("publications"), videos: t("videos"), data: t("data"), notes: t("notes"), openFile: t("openFile"), open: t("open"), openLink: t("openLink"), itemTypes: { article: t("articleType"), pdf: t("pdfType"), video: t("videoType"), data: t("dataType"), dataset: t("dataType"), link: t("linkType"), "web-link": t("linkType"), note: t("noteType"), markdown: t("noteType"), attachment: t("fileType"), book: t("bookType"), "research-paper": t("paperType"), text: t("textType") }, pin: t("pin"), unpin: t("unpin"), fileUnavailable: t("fileUnavailable"), readMore: t("readMore"), showLess: t("showLess"), updated: t("updated"), editKnowledge: t("editKnowledge"), removeKnowledge: t("removeKnowledge") }} />
          )}
          </div>
        </aside>
      </main>}
      {currentView === "topic" || (currentView === "universe" && universePanelNode && (universe?.nodes.length ?? 0) > 1) ? <nav className="mobile-tabs" aria-label={t("appName")}><button type="button" aria-pressed={mobileView === "map"} onClick={() => setMobileView("map")}><Icon name={currentView === "universe" ? "universe" : "map"} />{t("map")}</button><button type="button" aria-pressed={mobileView === "knowledge"} onClick={() => setMobileView("knowledge")}><Icon name={currentView === "universe" ? "package" : "knowledge"} />{currentView === "universe" ? t("project") : t("knowledge")}</button></nav> : null}
      {projectLinkIssueId && project && projection ? <ProjectLinkDialog currentProjectId={project.manifest.id} projects={workspaceProjects} t={t} loadTopics={loadWorkspaceTopics} onClose={() => setProjectLinkIssueId(undefined)} onSubmit={async (selection: ProjectLinkSelection) => {
        await runMutation(() => api.linkProject({ sourceTopicId: projection.centralTopic.id, keyIssueId: projectLinkIssueId, ...selection }));
        showNotice(t("linkedProject"), async () => { await undoRedo("undo"); setNotice(undefined); });
      }} /> : null}
      {duplicateChoice ? <AuthoringDialog title={t("chooseProjectCopy")} onClose={() => setDuplicateChoice(undefined)}>
        <div className="duplicate-choices">{duplicateChoice.projects.map((choice) => <div className="duplicate-choice" key={choice.instanceId}>
          <button type="button" className="duplicate-choice__main" onClick={() => void (async () => {
            if (rememberDuplicate) await libraryApi.prefer(choice.projectId, choice.instanceId);
            const entry = { ...duplicateChoice.entry, instanceId: choice.instanceId, topicId: duplicateChoice.entry.topicId || choice.homeTopicId || "" };
            setDuplicateChoice(undefined);
            await navigateTo(entry);
          })()}><strong dir="auto">{choice.title}</strong><span dir="auto">{choice.directory}</span><small>{t("lastModified")}: {new Date(choice.lastSeenAt).toLocaleString(locale)} · {t("revision")} {new Intl.NumberFormat(locale).format(choice.revision)}</small></button>
          <button type="button" className="text-action" onClick={() => void (async () => {
            const changed = await libraryApi.newIdentity(choice.instanceId);
            const topic = changed.project.topics.find(({ id }) => id === changed.project.manifest.homeTopicId) ?? changed.project.topics[0];
            setDuplicateChoice(undefined);
            if (topic && changed.instanceId) await navigateTo({ kind: "topic", instanceId: changed.instanceId, projectId: changed.project.manifest.id, topicId: topic.id, label: topic.title, projectLabel: changed.project.manifest.title }, { activated: changed, force: true });
            else activateProject(changed);
          })()}>{t("giveOwnIdentity")}</button>
        </div>)}</div>
        <label className="check-field duplicate-remember"><input type="checkbox" checked={rememberDuplicate} onChange={(event) => setRememberDuplicate(event.target.checked)} />{t("rememberChoice")}</label>
        <div className="dialog-actions"><button type="button" className="pill" onClick={() => setDuplicateChoice(undefined)}>{t("cancel")}</button></div>
      </AuthoringDialog> : null}
      {blockedNavigation ? <AuthoringDialog title={t("saveError")} onClose={() => setBlockedNavigation(undefined)}><p>{t("conflictSave")}</p><div className="dialog-actions"><button type="button" className="pill" onClick={() => setBlockedNavigation(undefined)}>{t("stay")}</button><button type="button" className="pill pill--danger" onClick={() => { const entry = blockedNavigation; setBlockedNavigation(undefined); closeStudio(); void navigateTo(entry, { force: true }); }}>{t("leaveAnyway")}</button></div></AuthoringDialog> : null}
      {unavailableEntry ? <AuthoringDialog title={t("projectUnavailable")} onClose={() => setUnavailableEntry(undefined)}><p dir="auto">{unavailableEntry.projectLabel}</p><div className="dialog-actions"><button type="button" className="pill" onClick={() => setUnavailableEntry(undefined)}>{t("cancel")}</button><button type="button" className="pill pill--accent" onClick={() => void (async () => { const located = workspaceProjects.some(({ instanceId }) => instanceId === unavailableEntry.instanceId) ? await libraryApi.locate(unavailableEntry.instanceId) : await libraryApi.locateProject(unavailableEntry.projectId); if (!("cancelled" in located)) { const entry = { ...unavailableEntry, instanceId: located.project.instanceId, topicId: unavailableEntry.topicId || located.project.homeTopicId || "" }; setUnavailableEntry(undefined); await navigateTo(entry, { force: true }); } })()}>{t("locate")}</button></div></AuthoringDialog> : null}
      {portalOverflowOpen && projection ? <AuthoringDialog title={`+${overflowGroups.length} ${t("projectOverflow")}`} onClose={() => setPortalOverflowOpen(false)}>{(["outgoing", "incoming"] as const).map((direction) => {
        const groups = overflowGroups.filter(([first]) => first!.direction === direction);
        if (!groups.length) return null;
        const headingId = `portal-overflow-${direction}`;
        return <section className="portal-overflow-section" aria-labelledby={headingId} key={direction}>
          <h3 id={headingId} className="portal-overflow-section__title">{t(direction === "outgoing" ? "portalOutgoing" : "portalIncoming")}</h3>
          <div className="portal-overflow-list">{groups.map((group) => {
            const portal = group[0]!;
            return <button type="button" key={portal.id} aria-label={`${portal.direction === "incoming" ? t("incomingLinkFrom") : t("linkedProject")}: ${portal.projectTitle}`} onClick={() => { setPortalOverflowOpen(false); setSelectedPortalId(portal.id); }}><Icon name="package" /><span dir="auto">{portal.projectTitle}</span><small>{portal.direction === "incoming"
              ? [unique(group.flatMap((link) => link.direction === "incoming" ? [link.sourceTopicTitle] : [])), unique(group.flatMap((link) => link.direction === "incoming" ? [link.sourceKeyIssueTitle] : []))].join(" · ")
              : `${t("linkedVia")} ${unique(group.flatMap((link) => link.direction === "outgoing" ? [link.keyIssueTitle] : []))}`}</small></button>;
          })}</div>
        </section>;
      })}</AuthoringDialog> : null}
      {universeForget ? <AuthoringDialog title={t("forgetProject")} onClose={() => { if (!universeBusy) setUniverseForget(undefined); }}><p>{t("forgetProjectBody")}</p><div className="dialog-actions"><button type="button" className="pill" disabled={universeBusy} onClick={() => setUniverseForget(undefined)}>{t("cancel")}</button><button type="button" className="pill pill--danger" aria-busy={universeBusy} disabled={universeBusy} onClick={() => void forgetUniverseProject()}>{universeBusy ? <Spinner /> : null}{t("forgetProject")}</button></div></AuthoringDialog> : null}
      {folderImportOpen && project ? <FolderImportDialog project={project} target={contextTarget ?? undefined} api={folderApi} locale={locale} t={t} onClose={() => setFolderImportOpen(false)} onMutation={applyMutation} onBusyChange={setTransferBusy} /> : null}
      {projectSettingsOpen && project ? <ProjectSettingsDialog project={project} resyncToken={resyncToken} t={t} onSave={saveProjectText} onSaveCopy={async () => { if (studioFlush.current && !await studioFlush.current()) return; await mutationQueue.current.catch(() => undefined); const result = await libraryApi.saveCopy(); setProjectSettingsOpen(false); setCopyOffer(result.project); }} onClose={() => setProjectSettingsOpen(false)} /> : null}
      {copyOffer ? <AuthoringDialog title={t("copyCreated")} onClose={() => setCopyOffer(undefined)}><p dir="auto">{copyOffer.directory}</p><div className="dialog-actions"><button type="button" className="pill" onClick={() => setCopyOffer(undefined)}>{t("done")}</button><button type="button" className="pill pill--accent" onClick={() => void (async () => { const result = await libraryApi.activate(copyOffer.instanceId); const topic = result.project.topics.find(({ id }) => id === result.project.manifest.homeTopicId) ?? result.project.topics[0]; setCopyOffer(undefined); if (topic && result.instanceId) await navigateTo({ kind: "topic", instanceId: result.instanceId, projectId: result.project.manifest.id, topicId: topic.id, label: topic.title, projectLabel: result.project.manifest.title }, { activated: result, force: true }); })()}>{t("openCopy")}</button></div></AuthoringDialog> : null}
      {addTopicOpen ? <AuthoringDialog title={t("addTopic")} onClose={() => { if (!topicBusy) setAddTopicOpen(false); }}>
        <form onSubmit={(event) => { event.preventDefault(); void addTopic(); }}>
          <label className="field"><span>{t("title")}</span><input autoFocus required value={topicTitle} disabled={topicBusy} onChange={(event) => setTopicTitle(event.target.value)} /></label>
          {topicError ? <p className="field-error" role="alert">{topicError}</p> : null}
          <div className="dialog-actions"><button type="button" className="pill" disabled={topicBusy} onClick={() => setAddTopicOpen(false)}>{t("cancel")}</button><button type="submit" className="pill pill--accent" disabled={topicBusy || !topicTitle.trim()}>{topicBusy ? t("saving") : t("addTopic")}</button></div>
        </form>
      </AuthoringDialog> : null}
      {knowledgeEditor && project && project.associations.some(({ id }) => id === knowledgeEditor.associationId) ? <KnowledgeEditor key={`${knowledgeEditor.associationId}:${knowledgeEditor.removing}`} project={project} associationId={knowledgeEditor.associationId} removing={knowledgeEditor.removing} t={t} onClose={() => setKnowledgeEditor(undefined)} onSave={async (input) => {
        await runMutation(() => api.editKnowledge(knowledgeEditor.associationId, input));
        showNotice(t("knowledgeUpdated"));
      }} onRemove={async (scope) => {
        await runMutation(() => api.removeKnowledge(knowledgeEditor.associationId, scope));
        showNotice(t("knowledgeRemoved"), async () => {
          await undoRedo("undo");
          setNotice(undefined);
        });
      }} /> : null}
      {searchOpen ? (
        <div className="dialog-scrim search-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSearch(); }}>
          <section ref={searchDialog} className="search-dialog" role="dialog" aria-modal="true" aria-label={t("search")}>
            <div className="search-input-row">
              {searchBusy ? <Spinner className="search-input-row__indicator" /> : <Icon name="search" />}
              <input ref={searchInput} autoFocus type="search" value={searchText} placeholder={t("searchPlaceholder")} aria-label={t("search")} aria-keyshortcuts="ArrowDown" onChange={(event) => setSearchText(event.target.value)} onKeyDown={(event) => {
                const first = searchResults.current?.querySelector<HTMLButtonElement>(".search-result");
                if (event.key === "ArrowDown" && first) {
                  event.preventDefault();
                  first.focus();
                } else if (event.key === "Enter" && first && !searchBusy) {
                  event.preventDefault();
                  first.click();
                }
              }} />
              {searchText ? <button type="button" className="text-action search-clear" onClick={() => { setSearchText(""); searchInput.current?.focus(); }}>{t("clearSearch")}</button> : null}
              <button type="button" className="tool" aria-label={t("closeSearch")} data-tooltip={t("closeSearch")} data-tooltip-side="bottom" data-tooltip-align="end" onClick={closeSearch}><Icon name="close" /></button>
            </div>
            <div className="search-controls">
              <SearchScopeToggle value={searchScope} label={t("searchScope")} projectLabel={t("thisProject")} workspaceLabel={t("allProjects")} onChange={setSearchScope} />
              <div className="search-filters" role="group" aria-label={t("searchFilters")}>
                {(["all", "topic", "keyIssue", "knowledgeItem"] as const).map((kind) => (
                  <button type="button" aria-pressed={searchKind === kind} onClick={() => setSearchKind(kind)} key={kind}>{t(kind === "all" ? "allResults" : kind === "topic" ? "topics" : kind === "keyIssue" ? "issues" : "knowledgeItems")}</button>
                ))}
              </div>
            </div>
            <div className="search-status" role="status" aria-live="polite">{searchBusy ? t("searching") : searchError ? searchError : `${visibleSearchPage.totalCapped ? `${new Intl.NumberFormat(locale).format(50)}+` : new Intl.NumberFormat(locale).format(visibleSearchPage.total)} ${t("results")}`}</div>
            {searchScope === "workspace" && (visibleSearchPage.notSearchableCount || visibleSearchPage.staleProjectCount || visibleSearchPage.incomplete) ? <div className="search-notes" role="status">
              {visibleSearchPage.notSearchableCount ? <p><Icon name="alert" />{t("searchNotOpened").replace("{count}", new Intl.NumberFormat(locale).format(visibleSearchPage.notSearchableCount))}</p> : null}
              {visibleSearchPage.staleProjectCount ? <p><Icon name="clock" />{t("searchOutOfDate").replace("{count}", new Intl.NumberFormat(locale).format(visibleSearchPage.staleProjectCount))}</p> : null}
              {visibleSearchPage.incomplete ? <p><Icon name="alert" />{t("searchIncomplete")}</p> : null}
            </div> : null}
            <div ref={searchResults} className="search-results" aria-busy={searchBusy} onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".search-result")];
              const index = rows.indexOf(document.activeElement as HTMLButtonElement);
              if (index < 0) return;
              event.preventDefault();
              if (event.key === "ArrowUp" && index === 0) searchInput.current?.focus();
              else rows[event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
            }}>
              {visibleSearchPage.items.length === 0 ? (
                <div className={`search-state${searchError && !searchBusy ? " search-state--error" : ""}`}>
                  {searchBusy ? <Spinner className="spinner--large" /> : <Icon name={searchError ? "alert" : "search"} />}
                  {searchBusy ? null : <p className="search-empty">{searchError ? t("searchError") : t("noSearchResults")}</p>}
                </div>
              ) : null}
              {visibleSearchPage.items.map((hit) => (
                <button type="button" className="search-result" key={`${hit.sourceInstanceId ?? activeInstanceId}:${hit.kind}:${hit.id}`} onClick={() => void activateSearchHit(hit)}>
                  <span className="search-result__copy">
                    <strong dir="auto">{hit.title}</strong>
                    {hit.summary ? <small dir="auto">{hit.summary}</small> : null}
                    {searchScope === "workspace" && hit.sourceProjectTitle ? <small className="search-result__source"><Icon name="package" /><span className="visually-hidden">{t("sourceProject")}: </span><span dir="auto">{hit.sourceProjectTitle}</span></small> : null}
                  </span>
                  <span className="search-result__type">{t(hit.kind === "topic" ? "topic" : hit.kind === "keyIssue" ? "keyIssue" : "knowledge")}</span>
                </button>
              ))}
              {visibleSearchPage.nextCursor || visibleSearchPage.continuation ? <button type="button" className="pill search-more" aria-busy={searchBusy} disabled={searchBusy} onClick={() => void loadMoreSearch()}>{searchBusy ? <Spinner /> : null}{t(searchScope === "workspace" ? "searchRemaining" : "loadMore")}</button> : null}
            </div>
          </section>
        </div>
      ) : null}
      {importPlan ? (
        <div className="dialog-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !transferBusy) void closeImport(); }}>
          <section className="transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <p className="eyebrow">{t("validatedPackage")}</p>
            <h2 id="import-title" dir="auto">{importPlan.projectTitle}</h2>
            <div className="import-body">
              <dl className="import-summary">
                <div><dt>{t("revision")}</dt><dd>{new Intl.NumberFormat(locale).format(importPlan.projectRevision)}</dd></div>
                <div><dt>{t("packageFiles")}</dt><dd>{new Intl.NumberFormat(locale).format(importPlan.entryCount)}</dd></div>
                <div><dt>{t("assets")}</dt><dd>{new Intl.NumberFormat(locale).format(importPlan.assetCount)}</dd></div>
              </dl>
              {importPlan.warnings.length ? <div className="import-warnings" role="status">{importPlan.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
              {workspaceProjects.some(({ projectId }) => projectId === importPlan.projectId) ? (
                <fieldset className="import-mode" disabled={transferBusy}>
                  <legend>{t("projectDuplicate")}</legend>
                  <label className="check-field"><input type="radio" name="import-mode" value="copy" checked={importMode === "copy"} onChange={() => setImportMode("copy")} />{t("importAsCopy")}</label>
                  <label className="check-field"><input type="radio" name="import-mode" value="anyway" checked={importMode === "anyway"} onChange={() => setImportMode("anyway")} />{t("importAnyway")}</label>
                </fieldset>
              ) : null}
              <label className="field"><span>{t("projectFolder")}</span><input autoFocus value={importDirectory} disabled={transferBusy} onChange={(event) => setImportDirectory(event.target.value)} /></label>
            </div>
            <div className="dialog-actions">
              <button type="button" className="pill" disabled={transferBusy} onClick={() => void closeImport()}>{t("cancel")}</button>
              <button type="button" className="pill pill--accent" aria-busy={transferAction === "commit"} disabled={transferBusy || !importDirectory.trim()} onClick={() => void commitImport()}>{transferAction === "commit" ? <Spinner /> : null}{transferAction === "commit" ? t("importingProject") : t("importProject")}</button>
            </div>
          </section>
        </div>
      ) : null}
      {packagePickerOpen ? <AuthoringDialog title={t("importPackageTitle")} onClose={() => { if (transferAction !== "preview") setPackagePickerOpen(false); }}>
        <p className="dialog-intro">{t("importPackageIntro")}</p>
        <FilePicker icon="package" label={t("chooseImportPackage")} inputLabel={t("importPackage")} hint={t("importPackageTypes")} busyLabel={t("validatingPackage")} busy={transferAction === "preview"} progress={packageProgress} locale={locale} disabled={transferBusy && transferAction !== "preview"} error={packageError} onFile={(file) => void previewImport(file)} />
        <div className="dialog-actions"><button type="button" className="pill" disabled={transferAction === "preview"} onClick={() => setPackagePickerOpen(false)}>{t("cancel")}</button></div>
      </AuthoringDialog> : null}
      {notice ? <div className="toast" data-tone={noticeTone} role={noticeTone === "error" ? "alert" : "status"}><Icon name={noticeTone === "error" ? "alert" : "success"} /><span>{notice}</span>{noticeCanUndo && commandHistory.canUndo && project?.topics.length ? <button className="pill" type="button" disabled={saveState === "saving"} onClick={() => void noticeUndo.current?.().catch(() => {})}>{t("undo")}</button> : null}{noticeCanReload ? <button className="pill" type="button" onClick={() => void libraryApi.reload().then((result) => { activateProject(result); setNotice(undefined); setNoticeCanReload(false); })}>{t("reloadProject")}</button> : null}</div> : null}
    </div>
  );
}
