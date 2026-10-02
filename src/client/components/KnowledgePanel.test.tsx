import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { queryKnowledgeContext } from "../../domain/knowledge-query.js";
import type { Asset, KnowledgeItem } from "../../domain/types.js";
import { createValidProject, timestamp } from "../../test/project-fixtures.js";
import { messages, type Locale } from "../locales.js";
import { KnowledgePanel } from "./KnowledgePanel.js";

const firstItem: KnowledgeItem = {
  id: "item-first", type: "article", title: "First publication", source: "Research institute",
  publishedAt: timestamp, summary: "First summary", availability: "external",
  externalUrl: "https://example.org/first", tags: ["research"], createdAt: timestamp, updatedAt: timestamp
};
const secondItem: KnowledgeItem = {
  id: "item-second", type: "note", title: "Second note", body: "Second summary",
  availability: "local", attachmentAssetIds: ["asset-local", "asset-missing"], createdAt: timestamp, updatedAt: timestamp
};
const asset: Asset = {
  id: "asset-local", path: "assets/local.txt", originalFilename: "local.txt", mimeType: "text/plain",
  byteSize: 5, sha256: "a".repeat(64), createdAt: timestamp
};

function contextFor(items = [firstItem, secondItem]) {
  const project = createValidProject();
  project.knowledgeItems = items;
  project.associations = items.map((item) => ({
    id: `association-${item.id}`, knowledgeItemId: item.id, targetKind: "topic", targetId: "topic-1"
  }));
  return queryKnowledgeContext(project, { kind: "topic", id: "topic-1" });
}

function propsFor(locale: Locale = "en") {
  const text = messages[locale];
  return {
    context: contextFor(), locale, assets: [asset], onEdit: vi.fn(), onTogglePin: vi.fn(async () => undefined),
    onEditKnowledge: vi.fn(), onRemoveKnowledge: vi.fn(),
    labels: { ...text, topic: text.centralTopic, itemTypes: { article: text.articleType, note: text.noteType, link: text.linkType } }
  };
}

describe("Knowledge item disclosure", () => {
  it("opens items independently, keeps repeated items synchronized, and hides collapsed actions", async () => {
    render(<KnowledgePanel {...propsFor()} />);
    const firstRows = screen.getAllByRole("button", { name: /First publication/ });
    const secondRow = screen.getByRole("button", { name: /Second note/ });
    await waitFor(() => expect(firstRows[0]).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByRole("link", { name: "Open" })).not.toBeInTheDocument();
    const detailsIds = [...firstRows, secondRow].map((row) => row.getAttribute("aria-controls"));
    expect(new Set(detailsIds).size).toBe(detailsIds.length);
    for (const id of detailsIds) expect(document.getElementById(id!)).toHaveAttribute("hidden");

    fireEvent.click(firstRows[0]);
    fireEvent.click(secondRow);
    expect(firstRows.every((row) => row.getAttribute("aria-expanded") === "true")).toBe(true);
    expect(secondRow).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(firstRows[1]);
    expect(firstRows.every((row) => row.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(secondRow).toHaveAttribute("aria-expanded", "true");
  });

  it("clears disclosure when the selected context changes", async () => {
    const props = propsFor();
    const { rerender } = render(<KnowledgePanel {...props} />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.click(screen.getAllByRole("button", { name: /First publication/ })[0]);
    rerender(<KnowledgePanel {...props} context={{ ...props.context, target: { kind: "keyIssue", id: "issue-1" } }} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /First publication/ })[0]).toHaveAttribute("aria-expanded", "false"));
  });

  it("preserves external and managed-file actions and identifies missing attachments", async () => {
    render(<KnowledgePanel {...propsFor()} />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.click(screen.getAllByRole("button", { name: /First publication/ })[0]);
    const external = screen.getAllByRole("link", { name: "Open" })[0];
    expect(external).toHaveAttribute("href", "https://example.org/first");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("rel", "noreferrer");
    fireEvent.click(screen.getByRole("button", { name: /Second note/ }));
    expect(screen.getByRole("link", { name: /local\.txt.*Open file/ })).toHaveAttribute("href", "/api/assets/asset-local");
    expect(within(screen.getByRole("button", { name: /Second note/ }).closest("article")!).getByRole("link", { name: "Open" })).toHaveAttribute("href", "/api/assets/asset-local");
    expect(screen.getByText("File unavailable")).toBeInTheDocument();
  });

  it("keeps Open, Pin, and labelled icon-only Edit and Remove actions in one row", async () => {
    const props = propsFor();
    render(<KnowledgePanel {...props} />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.click(screen.getByRole("button", { name: /Second note/ }));
    const article = screen.getByRole("button", { name: /Second note/ }).closest("article")!;
    const row = article.querySelector(".knowledge-item__actions")!;
    const edit = within(article).getByRole("button", { name: "Edit item" });
    const remove = within(article).getByRole("button", { name: "Remove item" });
    for (const control of [within(article).getByRole("link", { name: "Open" }), within(article).getByRole("button", { name: "Pin" }), edit, remove]) {
      expect(row).toContainElement(control);
    }
    expect(edit).toHaveAttribute("data-tooltip", "Edit item");
    expect(edit).not.toHaveTextContent(/\S/);
    expect(remove).toHaveClass("icon-action--danger");
    expect(remove).not.toHaveTextContent(/\S/);
    fireEvent.click(remove);
    expect(props.onRemoveKnowledge).toHaveBeenCalledWith("association-item-second");
  });

  it("tracks pending pins independently and restores failed actions", async () => {
    let resolveFirst: () => void = () => undefined;
    let rejectSecond: (reason: Error) => void = () => undefined;
    const onTogglePin = vi.fn((id: string) => id === "association-item-first"
      ? new Promise<void>((resolve) => { resolveFirst = resolve; })
      : new Promise<void>((_resolve, reject) => { rejectSecond = reject; }));
    render(<KnowledgePanel {...propsFor()} onTogglePin={onTogglePin} />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    fireEvent.click(screen.getAllByRole("button", { name: /First publication/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: /Second note/ }));
    const firstPin = within(screen.getAllByRole("button", { name: /First publication/ })[0].closest("article")!).getByRole("button", { name: "Pin" });
    const secondPin = within(screen.getByRole("button", { name: /Second note/ }).closest("article")!).getByRole("button", { name: "Pin" });
    fireEvent.click(firstPin);
    fireEvent.click(secondPin);
    expect(onTogglePin).toHaveBeenCalledWith("association-item-first", true);
    expect(onTogglePin).toHaveBeenCalledWith("association-item-second", true);
    expect(firstPin).toBeDisabled();
    expect(secondPin).toBeDisabled();
    await act(async () => { resolveFirst(); });
    expect(firstPin).toBeEnabled();
    expect(secondPin).toBeDisabled();
    await act(async () => { rejectSecond(new Error("Save failed")); });
    expect(secondPin).toBeEnabled();
  });

  it.each(["en", "ar", "ru"] as const)("localizes item types and actions in %s without changing project copy", async (locale) => {
    const props = propsFor(locale);
    props.context = contextFor([{ ...firstItem, type: "link" }, { ...secondItem, type: "custom-record", attachmentAssetIds: [] }]);
    render(<KnowledgePanel {...props} preview />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const row = screen.getAllByRole("button", { name: /First publication/ })[0];
    expect(within(row).getByText(messages[locale].linkType)).toBeInTheDocument();
    expect(screen.getByText("custom-record")).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.getAllByRole("link", { name: messages[locale].openLink })[0]).toHaveAttribute("href", "https://example.org/first");
    expect(screen.queryByRole("button", { name: messages[locale].pin })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Second note/ }));
    expect(screen.getByRole("button", { name: messages[locale].open })).toBeDisabled();
  });
});
