import { fireEvent, render, screen, within } from "@testing-library/react";
import { TopicCombobox } from "./TopicCombobox.js";

const topics = [
  { id: "topic-models", title: "World Models" },
  { id: "topic-policy", title: "Policy" },
  { id: "topic-ethics", title: "Ethics" }
];

function renderCombobox() {
  const onSelect = vi.fn();
  const onCreate = vi.fn();
  render(<TopicCombobox label="Add relationship" placeholder="Find or create a Topic" createLabel="Create and link new Topic…" createHint="Type a title first" topics={topics} onSelect={onSelect} onCreate={onCreate} />);
  const input = screen.getByRole("combobox", { name: "Add relationship" });
  return { input, onSelect, onCreate };
}

const activeOption = (input: HTMLElement) => document.getElementById(input.getAttribute("aria-activedescendant") ?? "");

describe("Topic combobox", () => {
  it("opens with arrows and moves through options with Arrow, Home, and End, wrapping at the edges", () => {
    const { input } = renderCombobox();
    input.focus();
    expect(input).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(activeOption(input)).toHaveTextContent("World Models");
    expect(activeOption(input)).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeOption(input)).toHaveTextContent("Policy");
    fireEvent.keyDown(input, { key: "End" });
    expect(activeOption(input)).toHaveTextContent("Create and link new Topic…");
    expect(activeOption(input)).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeOption(input)).toHaveTextContent("World Models");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(activeOption(input)).toHaveTextContent("Create and link");
    fireEvent.keyDown(input, { key: "Home" });
    expect(activeOption(input)).toHaveTextContent("World Models");
    expect(input).toHaveFocus();
  });

  it("filters by typeahead and selects the highlighted Topic with Enter", () => {
    const { input, onSelect } = renderCombobox();
    fireEvent.change(input, { target: { value: "pol" } });
    const listbox = screen.getByRole("listbox", { name: "Add relationship" });
    expect(within(listbox).getAllByRole("option").map((option) => option.textContent)).toEqual(["Policy", "Create and link new Topic…pol"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("topic-policy");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("creates and links a new Topic from the typed title, and never with an empty title", () => {
    const { input, onCreate } = renderCombobox();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(activeOption(input)).toHaveTextContent("Create and link");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "  Governance  " } });
    expect(activeOption(input)).toHaveTextContent("Create and link new Topic…Governance");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith("Governance");
  });

  it("closes with Escape first, then clears the text, without letting Escape reach Studio", () => {
    const { input } = renderCombobox();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.change(input, { target: { value: "eth" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).toHaveValue("eth");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener("keydown", outer);
  });
});
