import type { EntityId } from "../../domain/types.js";
import type { GraphProjection } from "../../graph/projection.js";

interface RelationshipNavigatorProps {
  projection: GraphProjection;
  title: string;
  alsoViaLabel: string;
  onSelectKeyIssue: (id: EntityId) => void;
  onSelectRelatedTopic: (id: EntityId) => void;
}

export function RelationshipNavigator({
  projection,
  title,
  alsoViaLabel,
  onSelectKeyIssue,
  onSelectRelatedTopic
}: RelationshipNavigatorProps) {
  const issueTitles = new Map(projection.keyIssues.map((issue) => [issue.id, issue.title]));

  return (
    <section className="relationship-navigator" aria-label={title}>
      <h2 dir="auto">{projection.centralTopic.title}</h2>
      {projection.semanticRelationships.map((group) => (
        <section key={group.keyIssueId}>
          <h3>
            <button type="button" onClick={() => onSelectKeyIssue(group.keyIssueId)} dir="auto">
              {group.keyIssueTitle}
            </button>
          </h3>
          <ul>
            {group.relatedTopics.map((topic) => (
              <li key={`${group.keyIssueId}:${topic.topicId}`}>
                <button type="button" onClick={() => onSelectRelatedTopic(topic.topicId)} dir="auto">
                  {topic.title}
                </button>
                {topic.alsoViaKeyIssueIds.length > 0 ? (
                  <small dir="auto">
                    {alsoViaLabel} {topic.alsoViaKeyIssueIds.map((id) => issueTitles.get(id)).join(", ")}
                  </small>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
