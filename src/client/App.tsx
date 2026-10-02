import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { queryKnowledgeContext, type KnowledgeContextTarget } from "../domain/knowledge-query.js";
import type { CanonicalProject, EntityId } from "../domain/types.js";
import { buildGraphProjection, type GraphProjection } from "../graph/projection.js";
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
  trackProject,
  type FolderImportApi,
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
import { StudioPanel } from "./components/StudioPanel.js";
import { directionForLocale, localeNames, messages, type Locale, type MessageKey } from "./locales.js";
import { localizeDisplayProject, localizeSearchHit } from "./display-localization.js";
import { APPLICATION_VERSION } from "../version.js";

type Theme = "light" | "dark";
type MobileView = "map" | "knowledge";
type ApplicationMode = "viewer" | "studio";
type NoticeTone = "success" | "error";
type TransferAction = "export" | "preview" | "cancel" | "commit";

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
  const [topicHistory, setTopicHistory] = useState<EntityId[]>([]);
  const [previousProjection, setPreviousProjection] = useState<GraphProjection>();
  const [focusToken, setFocusToken] = useState(0);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [commandHistory, setCommandHistory] = useState<HistoryState>({ canUndo: false, canRedo: false });
  const [notice, setNotice] = useState<string>();
  const [noticeCanUndo, setNoticeCanUndo] = useState(false);
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("success");
  const [importPlan, setImportPlan] = useState<ImportPlan>();
  const [importDirectory, setImportDirectory] = useState("");
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
  const [searchPage, setSearchPage] = useState<SearchPage>({ items: [], total: 0 });
  const [searchResultText, setSearchResultText] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [transitioningTopicId, setTransitioningTopicId] = useState<EntityId>();
  const noticeTimer = useRef<number | undefined>(undefined);
  const noticeUndo = useRef<(() => Promise<void>) | undefined>(undefined);
  const navigationTimer = useRef<number | undefined>(undefined);
  const importButton = useRef<HTMLButtonElement>(null);
  const folderImportButton = useRef<HTMLButtonElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsPopover = useRef<HTMLElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const historyPopover = useRef<HTMLDivElement>(null);
  const languageButton = useRef<HTMLButtonElement>(null);
  const languageOptions = useRef<Array<HTMLButtonElement | null>>([]);
  const searchDialog = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchResults = useRef<HTMLDivElement>(null);
  const searchRequest = useRef(0);
  const text = useMemo(() => messages[locale], [locale]);
  const t = useCallback((key: MessageKey) => text[key], [text]);
  const displayProject = useMemo(() => project ? localizeDisplayProject(project, locale) : null, [locale, project]);
  const restoreImportFocus = useCallback(() => window.setTimeout(() => (importButton.current ?? settingsButton.current)?.focus(), 0), []);

  useEffect(() => {
    let active = true;
    loadProject()
      .then((loaded) => {
        if (!active) return;
        trackProject(loaded);
        setProject(loaded);
        setCentralTopicId(
          loaded.manifest.homeTopicId ?? [...loaded.topics].sort((a, b) => a.id.localeCompare(b.id))[0]?.id ?? null
        );
        setLoadError(false);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [loadAttempt, loadProject]);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = directionForLocale(locale);
    document.documentElement.dataset.theme = theme;
    document.title = text.appName;
    document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.setAttribute(
      "href",
      theme === "dark" ? "/brand/outmapper-mark-light.svg" : "/brand/outmapper-mark-dark.svg"
    );
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
      "content",
      theme === "dark" ? "#0b0b0d" : "#eceef2"
    );
  }, [locale, text.appName, theme]);

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
      if (displayProject && centralTopicId) {
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
        match: "prefix",
        filters: searchKind === "all" ? undefined : { entityKinds: [searchKind] },
        limit: 20
      })
        .then((page) => {
          if (request === searchRequest.current) {
            setSearchPage({ ...page, items: page.items.map((hit) => localizeSearchHit(hit, locale, project?.manifest.id)) });
            setSearchResultText(searchText);
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
  }, [centralTopicId, displayProject, locale, project?.manifest.id, search, searchKind, searchOpen, searchText, text.searchError]);

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
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [historyOpen, languageOpen, searchOpen, settingsOpen]);

  useEffect(() => {
    if (!settingsOpen && !historyOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
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
    return buildGraphProjection(displayProject, centralTopicId, {
      selectedKeyIssueId,
      selectedRelatedTopicId,
      previousProjection
    });
  }, [centralTopicId, displayProject, previousProjection, selectedKeyIssueId, selectedRelatedTopicId]);
  const selectedIssue = projection?.keyIssues.find(({ id }) => id === selectedKeyIssueId);
  const selectedRelatedTopic = projection?.relatedTopics.find(({ id }) => id === selectedRelatedTopicId);
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
    noticeUndo.current = undo;
    setNoticeCanUndo(Boolean(undo));
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(undefined), undo ? 8000 : tone === "error" ? 7000 : 2800);
  }, []);
  const applyMutation = useCallback((result: ProjectMutationResponse) => {
    const topicIds = new Set(result.project.topics.map(({ id }) => id));
    const nextTopicId = centralTopicId && topicIds.has(centralTopicId) ? centralTopicId : result.project.manifest.homeTopicId ?? result.project.topics[0]?.id ?? null;
    const issueIds = new Set(result.project.keyIssues.filter(({ topicId }) => topicId === nextTopicId).map(({ id }) => id));
    const relatedIds = new Set(result.project.relationships.filter(({ sourceTopicId }) => sourceTopicId === nextTopicId).map(({ targetTopicId }) => targetTopicId));
    trackProject(result.project);
    setProject(result.project);
    setCentralTopicId(nextTopicId);
    setSelectedKeyIssueId((id) => id && issueIds.has(id) ? id : undefined);
    setSelectedRelatedTopicId((id) => id && relatedIds.has(id) ? id : undefined);
    setTopicHistory((ids) => ids.filter((id) => topicIds.has(id)));
    setCommandHistory(result.history);
    setSaveState("saved");
  }, [centralTopicId]);
  const activateProject = useCallback((result: ProjectMutationResponse) => {
    trackProject(result.project);
    setProject(result.project);
    setCentralTopicId(result.project.manifest.homeTopicId ?? result.project.topics[0]?.id ?? null);
    setSelectedKeyIssueId(undefined);
    setSelectedRelatedTopicId(undefined);
    setTopicHistory([]);
    setPreviousProjection(undefined);
    setCommandHistory(result.history);
    setSaveState("saved");
    setMode("viewer");
    setFolderImportOpen(false);
    setKnowledgeEditor(undefined);
    setSettingsOpen(false);
    setFocusToken((value) => value + 1);
  }, []);
  const runMutation = useCallback(
    async (operation: () => Promise<ProjectMutationResponse>, failureMessage?: string, quiet = false) => {
      setNotice(undefined);
      setNoticeCanUndo(false);
      setSaveState("saving");
      try {
        const result = await operation();
        applyMutation(result);
        return result;
      } catch (error) {
        setSaveState("error");
        if (!quiet) showNotice(failureMessage ?? (error instanceof ProjectRequestError && error.code === "conflicting-save"
          ? text.conflictSave
          : error instanceof Error ? error.message : text.saveError), undefined, "error");
        throw error;
      }
    },
    [applyMutation, showNotice, text.conflictSave, text.saveError]
  );

  const selectKeyIssue = (id: EntityId) => {
    setSelectedKeyIssueId((current) => (current === id ? undefined : id));
    setSelectedRelatedTopicId(undefined);
  };
  const selectRelatedTopic = (id: EntityId) => {
    setSelectedRelatedTopicId((current) => (current === id ? undefined : id));
    setSelectedKeyIssueId(undefined);
  };
  const clearSelection = () => {
    setSelectedKeyIssueId(undefined);
    setSelectedRelatedTopicId(undefined);
  };
  const navigate = (topicId: EntityId, addCurrentToHistory: boolean, animatePromotion = true) => {
    if (!projection || topicId === projection.centralTopic.id) return;
    const complete = () => {
      setPreviousProjection(projection);
      if (addCurrentToHistory) setTopicHistory((history) => [...history, projection.centralTopic.id]);
      setCentralTopicId(topicId);
      clearSelection();
      setTransitioningTopicId(undefined);
      setRelationshipsOpen(false);
      setHistoryOpen(false);
      setMode("viewer");
      setMobileView("map");
      setFocusToken((value) => value + 1);
    };
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (animatePromotion && projection.relatedTopics.some(({ id }) => id === topicId) && !reduceMotion) {
      setSelectedKeyIssueId(undefined);
      setSelectedRelatedTopicId(topicId);
      setTransitioningTopicId(topicId);
      navigationTimer.current = window.setTimeout(complete, 470);
    } else {
      complete();
    }
  };
  const goBack = () => {
    const previousTopicId = topicHistory.at(-1);
    if (!previousTopicId || !projection) return;
    setPreviousProjection(projection);
    setTopicHistory((history) => history.slice(0, -1));
    setCentralTopicId(previousTopicId);
    clearSelection();
    setMode("viewer");
    setFocusToken((value) => value + 1);
  };
  const goHome = () => {
    const homeTopicId = project?.manifest.homeTopicId;
    if (!homeTopicId || !projection) return;
    if (projection.centralTopic.id !== homeTopicId) setPreviousProjection(projection);
    setCentralTopicId(homeTopicId);
    setTopicHistory([]);
    clearSelection();
    setMode("viewer");
    setFocusToken((value) => value + 1);
  };

  const saveContext = useCallback(
    async (patch: { title: string; description: string }) => {
      if (!contextTarget) return;
      await runMutation(() =>
        contextTarget.kind === "topic"
          ? api.updateTopic(contextTarget.id, patch)
          : api.updateKeyIssue(contextTarget.id, patch)
      );
    },
    [api, contextTarget, runMutation]
  );

  const closeStudio = () => {
    setMode("viewer");
    window.setTimeout(() => document.querySelector<HTMLButtonElement>(".panel-edit")?.focus(), 0);
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
      await runMutation(() => api.undo());
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
      setCentralTopicId(added?.id ?? result.project.manifest.homeTopicId ?? result.project.topics[0]?.id ?? null);
      setPreviousProjection(undefined);
      setSelectedKeyIssueId(undefined);
      setSelectedRelatedTopicId(undefined);
      setTopicHistory([]);
      setTopicTitle("");
      setAddTopicOpen(false);
      setSettingsOpen(false);
      showNotice(t("topicAdded"), async () => {
        await runMutation(() => api.undo());
        setNotice(undefined);
      });
    } catch (caught) {
      setTopicError(caught instanceof Error ? caught.message : t("saveError"));
    } finally {
      setTopicBusy(false);
    }
  };

  const runTransfer = async (action: TransferAction, operation: () => Promise<void>, onError: (message: string) => void) => {
    setTransferBusy(true);
    setTransferAction(action);
    try {
      await operation();
    } catch (error) {
      onError(error instanceof Error && error.message ? error.message : t("transferError"));
    } finally {
      setTransferBusy(false);
      setTransferAction(undefined);
    }
  };
  const transferNotice = (message: string) => showNotice(message, undefined, "error");
  const exportProject = () => runTransfer("export", async () => {
    await transferApi.exportProject();
    showNotice(t("exportReady"));
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
    const result = await transferApi.commitImport(importPlan.id, importDirectory);
    setImportPlan(undefined);
    if (result.project && result.history) activateProject({ project: result.project, history: result.history });
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
  const activateSearchHit = (hit: SearchHit) => {
    const context = hit.contexts[0];
    const targetTopicId = hit.kind === "topic" ? hit.id : context?.topicId;
    if (targetTopicId && projection && targetTopicId !== projection.centralTopic.id) {
    setPreviousProjection(projection);
      setTopicHistory((history) => [...history, projection.centralTopic.id]);
      setCentralTopicId(targetTopicId);
    }
    setSelectedKeyIssueId(hit.kind === "keyIssue" ? hit.id : context?.keyIssueId);
    setSelectedRelatedTopicId(undefined);
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
    if (!searchPage.nextCursor) return;
    setSearchBusy(true);
    try {
      const next = await search({
        text: searchText,
        match: "prefix",
        filters: searchKind === "all" ? undefined : { entityKinds: [searchKind] },
        limit: 20,
        cursor: searchPage.nextCursor
      });
      setSearchPage((current) => ({ ...next, items: [...current.items, ...next.items.map((hit) => localizeSearchHit(hit, locale, project?.manifest.id))] }));
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : t("searchError"));
    } finally {
      setSearchBusy(false);
    }
  };

  const studioLabels = {
    studio: t("studio"), autosaved: t("autosaved"), saving: t("saving"), saveError: t("saveError"),
    title: t("title"), description: t("description"), titleRequired: t("titleRequired"), done: t("done"),
    undo: t("undo"), redo: t("redo"), relationships: t("relationships"),
    addRelationship: t("addRelationship"), removeRelationship: t("removeRelationship"),
    addKeyIssue: t("addKeyIssue"), addKnowledge: t("addKnowledge"), knowledgeTitle: t("knowledgeTitle"),
    knowledgeBody: t("knowledgeBody"), moveEarlier: t("moveEarlier"), moveLater: t("moveLater"),
    addNote: t("addNote"), knowledgeType: t("knowledgeType"), knowledgeUrl: t("knowledgeUrl"),
    knowledgeUrlHint: t("knowledgeUrlHint"), knowledgeUrlInvalid: t("knowledgeUrlInvalid"),
    knowledgeDescription: t("knowledgeDescription"), knowledgeAdding: t("knowledgeAdding"),
    knowledgeAddError: t("knowledgeAddError"),
    knowledgeTypes: { note: t("noteType"), article: t("articleType"), "research-paper": t("researchPaperType"), video: t("videoType"), dataset: t("datasetType"), "web-link": t("linkType") },
    attachFile: t("attachFile"), dropFile: t("dropFile"), uploading: t("uploading"),
    closeStudio: t("closeStudio"), deleteTopic: t("deleteTopic"), deleteKeyIssue: t("deleteKeyIssue"),
    deleteTopicBody: t("deleteTopicBody"), deleteKeyIssueBody: t("deleteKeyIssueBody"),
    deleteError: t("deleteError"), deleting: t("deleting"), cancel: t("cancel"), keyIssues: t("keyIssues")
  };
  const visibleSearchPage = searchResultText === searchText ? searchPage : { items: [], total: 0 };

  return (
    <div className="app" data-mobile-view={mobileView} data-mode={mode}>
      <header className="app-bar">
        <button ref={searchButton} className="tool" type="button" aria-label={t("search")} aria-haspopup="dialog" onClick={openSearch}><Icon name="search" /></button>
        <div className="brand" data-loading={!project && !loadError ? "true" : undefined} aria-label={t("appName")}><span className="brand-mark-frame"><img className="brand-mark" src={theme === "dark" ? "/brand/outmapper-mark-light.svg" : "/brand/outmapper-mark-dark.svg"} alt="" /></span><span className="brand-name">{t("appName")}</span></div>
        <div className="settings-wrap">
          <button ref={settingsButton} className="tool" type="button" aria-label={t("settings")} aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => {
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
              <div className="settings-section settings-section--language">
              <h2>{t("language")}</h2>
              <div className="language-select">
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
                  <span>{localeNames[locale]}</span><Icon name="chevronDown" />
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
                        <span>{localeNames[value]}</span><Icon name="check" />
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
              <ProjectMenu api={libraryApi} locale={locale} t={t} disabled={transferBusy || saveState === "saving"} onBeforeSwitch={async () => !transferBusy && saveState !== "saving"} onProject={activateProject}>
                <div className="settings-action-group">
                  <button type="button" className="popover-action" disabled={!project || transferBusy || saveState === "saving"} onClick={() => { setTopicError(""); setAddTopicOpen(true); }}><Icon name="map" /><span>{t("addTopic")}</span></button>
                  <button ref={folderImportButton} type="button" className="popover-action" disabled={!project || !project.topics.length || transferBusy || saveState === "saving"} onClick={() => setFolderImportOpen(true)}><Icon name="upload" /><span>{t("importFolder")}</span></button>
                </div>
                <div className="settings-action-group">
                  <button ref={importButton} type="button" className="popover-action" disabled={transferBusy || saveState === "saving"} onClick={() => { setPackageError(""); setPackagePickerOpen(true); }}><Icon name="package" /><span>{t("importPackage")}</span></button>
                  <button type="button" className="popover-action" aria-busy={transferAction === "export"} disabled={transferBusy || saveState === "saving"} onClick={() => void exportProject()}>{transferAction === "export" ? <Spinner /> : <Icon name="download" />}<span>{transferAction === "export" ? t("exportingPackage") : t("exportPackage")}</span></button>
                </div>
              </ProjectMenu>
              <p className="app-version">{t("appName")} {APPLICATION_VERSION}</p>
            </section>
          ) : null}
        </div>
      </header>
      <main className={`workspace ${panelOpen ? "" : "is-panel-closed"}`}>
        <section className="map-stage" aria-label={t("mapRegion")}>
          {projection ? (
            <>
              <MapViewer key={projection.centralTopic.id} projection={projection} direction={directionForLocale(locale)} coverImageUrl={centralCoverImageUrl} focusToken={focusToken} transitioningTopicId={transitioningTopicId} labels={{ mapLabel: `${t("mapRegion")}: ${projection.centralTopic.title}`, centralTopic: t("centralTopic"), keyIssue: t("keyIssue"), relatedTopic: t("relatedTopic"), connectedVia: t("connectedVia"), zoomIn: t("zoomIn"), zoomOut: t("zoomOut") }} onSelectKeyIssue={selectKeyIssue} onSelectRelatedTopic={(topicId) => navigate(topicId, true)} onClearSelection={clearSelection} />
              <div className="map-actions" role="toolbar">
                <div className="capsule">
                  <button className="tool" type="button" aria-label={t("back")} disabled={!topicHistory.length} onClick={goBack}><Icon name="back" /></button>
                  <button className="tool" type="button" aria-label={t("home")} onClick={goHome}><Icon name="home" /></button>
                  <button className="tool" type="button" aria-label={t("relationshipsList")} aria-pressed={relationshipsOpen} onClick={() => {
                    setRelationshipsOpen((open) => !open);
                    setSelectedRelatedTopicId(undefined);
                    setHistoryOpen(false);
                  }}><Icon name="list" /></button>
                </div>
              </div>
              <div className="history-control">
                <button ref={historyButton} className="pill history-trigger" type="button" aria-haspopup="menu" aria-expanded={historyOpen} onClick={() => {
                  setHistoryOpen((open) => !open);
                  setSettingsOpen(false);
                  setLanguageOpen(false);
                }}><Icon name="clock" /><span>{t("history")}</span><Icon name="chevronDown" /></button>
                {historyOpen ? <div ref={historyPopover} className="history-popover" role="menu">{topicHistory.length === 0 ? <span>{t("noHistory")}</span> : null}{[...topicHistory].reverse().map((topicId, index) => <button type="button" role="menuitem" key={`${topicId}:${index}`} onClick={() => navigate(topicId, true, false)}>{displayProject?.topics.find(({ id }) => id === topicId)?.title ?? topicId}</button>)}</div> : null}
              </div>
              {relationshipsOpen ? <RelationshipNavigator projection={projection} title={t("relationshipsList")} alsoViaLabel={t("alsoVia")} onSelectKeyIssue={selectKeyIssue} onSelectRelatedTopic={selectRelatedTopic} /> : null}
              {selectedRelatedTopic && !transitioningTopicId ? (
                <section className="topic-preview" aria-label={`${t("relatedTopic")}: ${selectedRelatedTopic.title}`}>
                  <button type="button" className="tool topic-preview__close" aria-label={t("closePreview")} onClick={() => setSelectedRelatedTopicId(undefined)}><Icon name="close" /></button>
                  <p className="eyebrow">{t("relatedTopic")} · {t("connectedVia")} {connectedIssueTitles?.join(" · ")}</p>
                  <h2 dir="auto">{selectedRelatedTopic.title}</h2>
                  <p dir="auto">{selectedRelatedTopic.description ?? t("noDescription")}</p>
                  <button className="pill pill--accent" type="button" onClick={() => navigate(selectedRelatedTopic.id, true)}>{t("openTopic")}</button>
                </section>
              ) : null}
              <button type="button" className="panel-toggle pill" aria-expanded={panelOpen} onClick={() => setPanelOpen((open) => !open)}><Icon name="panel" /><span>{panelOpen ? t("hidePanel") : t("showPanel")}</span></button>
            </>
          ) : (
            <div className="empty-region" data-loading={!project && !loadError ? "true" : undefined} role={loadError ? "alert" : "status"}>
              <span className="empty-orbit" aria-hidden="true"><img className="empty-orbit__mark" src={theme === "dark" ? "/brand/outmapper-mark-light.svg" : "/brand/outmapper-mark-dark.svg"} alt="" /></span>
              <div className="empty-region__copy">
              <p>{loadError ? t("loadError") : project ? t("emptyMap") : t("loadingMap")}</p>
              {loadError ? <button className="pill" type="button" onClick={() => { setLoadError(false); setLoadAttempt((attempt) => attempt + 1); }}>{t("retry")}</button> : project ? <div className="empty-region__actions">
                <button className="pill pill--accent" type="button" onClick={() => { setTopicError(""); setAddTopicOpen(true); }}><Icon name="plus" />{t("addTopic")}</button>
                {commandHistory.canUndo ? <button className="pill" type="button" disabled={saveState === "saving"} onClick={() => void runMutation(() => api.undo()).catch(() => {})}>{t("undo")}</button> : null}
              </div> : null}
              </div>
            </div>
          )}
        </section>
        <aside className="knowledge-panel" dir="ltr" aria-label={t("knowledgeRegion")}>
          <div className="knowledge-panel__content" dir={directionForLocale(locale)}>
          {mode === "studio" && project && projection && contextTarget ? (
            <StudioPanel key={`${contextTarget.kind}:${contextTarget.id}:${project.manifest.revision}`} project={project} displayTopics={displayProject?.topics} projection={projection} target={contextTarget} labels={studioLabels} locale={locale} saveState={saveState} history={commandHistory} onSave={saveContext} onClose={closeStudio} onDelete={deleteContext} onUndo={() => void runMutation(() => api.undo())} onRedo={() => void runMutation(() => api.redo())} onAddKeyIssue={async (title) => { await runMutation(() => api.createKeyIssue({ topicId: projection.centralTopic.id, title })); }} onReorderKeyIssues={async (ids) => { await runMutation(() => api.reorderKeyIssues(projection.centralTopic.id, ids)); }} onAddRelationship={async (targetTopicId) => { if (contextTarget.kind !== "keyIssue") return; await runMutation(() => api.connectTopics({ sourceTopicId: projection.centralTopic.id, keyIssueId: contextTarget.id, targetTopicId })); }} onRemoveRelationship={async (relationshipId) => { await runMutation(() => api.disconnectRelationship(relationshipId)); }} onReorderRelationships={async (ids) => { if (contextTarget.kind !== "keyIssue") return; await runMutation(() => api.reorderRelationships(contextTarget.id, ids)); }} onAddKnowledge={async (input) => {
              await runMutation(() => api.createKnowledge({ ...input, targetKind: contextTarget.kind, targetId: contextTarget.id }), t("knowledgeAddError"));
              showNotice(t("knowledgeAdded"));
              window.requestAnimationFrame(() => {
                if (document.activeElement === document.body) document.querySelector<HTMLInputElement>(".knowledge-form input[name='knowledgeTitle']")?.focus();
              });
            }} onAttachAsset={async (file, onProgress) => {
              await runMutation(() => assetApi.attachAsset(file, contextTarget, onProgress), undefined, true);
              showNotice(`${t("fileAttached")}: ${file.name}`);
            }} />
          ) : (
            <KnowledgePanel context={knowledgeContext} coverImageUrl={imageHrefFor(knowledgeContext?.entity.visualAssetId) ?? centralCoverImageUrl} locale={locale} assets={project?.assets ?? []} onEdit={() => setMode("studio")} onTogglePin={async (associationId, pinned) => { await runMutation(() => api.updateKnowledgeAssociation(associationId, { pinned })); }} onEditKnowledge={(associationId) => setKnowledgeEditor({ associationId, removing: false })} onRemoveKnowledge={(associationId) => setKnowledgeEditor({ associationId, removing: true })} labels={{ topic: t("centralTopic"), keyIssue: t("keyIssue"), edit: t("edit"), knowledge: t("knowledge"), noDescription: t("noDescription"), emptySection: t("emptySection"), local: t("local"), external: t("external"), pinned: t("pinned"), publications: t("publications"), videos: t("videos"), data: t("data"), notes: t("notes"), openFile: t("openFile"), open: t("open"), openLink: t("openLink"), itemTypes: { article: t("articleType"), pdf: t("pdfType"), video: t("videoType"), data: t("dataType"), dataset: t("dataType"), link: t("linkType"), "web-link": t("linkType"), note: t("noteType"), markdown: t("noteType"), attachment: t("fileType"), book: t("bookType"), "research-paper": t("paperType"), text: t("textType") }, pin: t("pin"), unpin: t("unpin"), fileUnavailable: t("fileUnavailable"), readMore: t("readMore"), showLess: t("showLess"), updated: t("updated"), editKnowledge: t("editKnowledge"), removeKnowledge: t("removeKnowledge") }} />
          )}
          </div>
        </aside>
      </main>
      <nav className="mobile-tabs" aria-label={t("appName")}><button type="button" aria-pressed={mobileView === "map"} onClick={() => setMobileView("map")}><Icon name="map" />{t("map")}</button><button type="button" aria-pressed={mobileView === "knowledge"} onClick={() => setMobileView("knowledge")}><Icon name="knowledge" />{t("knowledge")}</button></nav>
      {folderImportOpen && project ? <FolderImportDialog project={project} target={contextTarget ?? undefined} api={folderApi} locale={locale} t={t} onClose={() => setFolderImportOpen(false)} onMutation={applyMutation} onBusyChange={setTransferBusy} /> : null}
      {addTopicOpen ? <AuthoringDialog title={t("addTopic")} onClose={() => { if (!topicBusy) setAddTopicOpen(false); }}>
        <form onSubmit={(event) => { event.preventDefault(); void addTopic(); }}>
          <label className="field"><span>{t("title")}</span><input autoFocus required dir="auto" value={topicTitle} disabled={topicBusy} onChange={(event) => setTopicTitle(event.target.value)} /></label>
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
          await runMutation(() => api.undo());
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
              <button type="button" className="tool" aria-label={t("closeSearch")} onClick={closeSearch}><Icon name="close" /></button>
            </div>
            <div className="search-filters" aria-label={t("searchFilters")}>
              {(["all", "topic", "keyIssue", "knowledgeItem"] as const).map((kind) => (
                <button type="button" aria-pressed={searchKind === kind} onClick={() => setSearchKind(kind)} key={kind}>{t(kind === "all" ? "allResults" : kind === "topic" ? "topics" : kind === "keyIssue" ? "issues" : "knowledgeItems")}</button>
              ))}
            </div>
            <div className="search-status" role="status" aria-live="polite">{searchBusy ? t("searching") : searchError ? searchError : `${new Intl.NumberFormat(locale).format(visibleSearchPage.total)} ${t("results")}`}</div>
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
                <button type="button" className="search-result" key={`${hit.kind}:${hit.id}`} onClick={() => activateSearchHit(hit)}>
                  <span className="search-result__copy">
                    <strong dir="auto">{hit.title}</strong>
                    {hit.summary ? <small dir="auto">{hit.summary}</small> : null}
                  </span>
                  <span className="search-result__type">{t(hit.kind === "topic" ? "topic" : hit.kind === "keyIssue" ? "keyIssue" : "knowledge")}</span>
                </button>
              ))}
              {visibleSearchPage.nextCursor ? <button type="button" className="pill search-more" aria-busy={searchBusy} disabled={searchBusy} onClick={() => void loadMoreSearch()}>{searchBusy ? <Spinner /> : null}{t("loadMore")}</button> : null}
            </div>
          </section>
        </div>
      ) : null}
      {importPlan ? (
        <div className="dialog-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !transferBusy) void closeImport(); }}>
          <section className="transfer-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <p className="eyebrow">{t("validatedPackage")}</p>
            <h2 id="import-title" dir="auto">{importPlan.projectTitle}</h2>
            <dl className="import-summary">
              <div><dt>{t("revision")}</dt><dd>{new Intl.NumberFormat(locale).format(importPlan.projectRevision)}</dd></div>
              <div><dt>{t("packageFiles")}</dt><dd>{new Intl.NumberFormat(locale).format(importPlan.entryCount)}</dd></div>
              <div><dt>{t("assets")}</dt><dd>{new Intl.NumberFormat(locale).format(importPlan.assetCount)}</dd></div>
            </dl>
            {importPlan.warnings.length ? <div className="import-warnings" role="status">{importPlan.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div> : null}
            <label className="field"><span>{t("projectFolder")}</span><input autoFocus value={importDirectory} onChange={(event) => setImportDirectory(event.target.value)} /></label>
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
      {notice ? <div className="toast" data-tone={noticeTone} role={noticeTone === "error" ? "alert" : "status"}><Icon name={noticeTone === "error" ? "alert" : "success"} /><span>{notice}</span>{noticeCanUndo && commandHistory.canUndo && project?.topics.length ? <button className="pill" type="button" disabled={saveState === "saving"} onClick={() => void noticeUndo.current?.().catch(() => {})}>{t("undo")}</button> : null}</div> : null}
    </div>
  );
}
