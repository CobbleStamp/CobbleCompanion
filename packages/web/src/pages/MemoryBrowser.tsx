import type { CompanionDto, MemorySnapshotDto, MessageDto } from '@cobble/shared';
import { useEffect, useState } from 'react';
import { fetchMessages, getCompanionMemory } from '../api/client.js';

interface MemoryBrowserProps {
  readonly companion: CompanionDto;
  readonly onBack: () => void;
}

/**
 * Read-only memory browser (companionmemory.md). Shows what the companion holds,
 * grouped by memory kind. Phase 0 has only the episodic transcript; semantic and
 * procedural render as "coming soon" so the full knowledge-base shape is visible.
 */
export function MemoryBrowser({ companion, onBack }: MemoryBrowserProps): JSX.Element {
  const [snapshot, setSnapshot] = useState<MemorySnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openConversationId, setOpenConversationId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<MessageDto[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        setSnapshot(await getCompanionMemory(companion.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load memory');
      }
    })();
  }, [companion.id]);

  async function openConversation(conversationId: string): Promise<void> {
    if (openConversationId === conversationId) {
      setOpenConversationId(null);
      setTranscript([]);
      return;
    }
    setOpenConversationId(conversationId);
    setTranscript(await fetchMessages(companion.id, conversationId));
  }

  return (
    <main className="chat">
      <header>
        <h1>{companion.name} · Memory</h1>
        <button type="button" onClick={onBack}>
          Back to chat
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {!snapshot && !error && <p>Loading memory…</p>}

      {snapshot && (
        <div className="memory-sections">
          <section className="memory-section">
            <h2>Identity</h2>
            <p>
              <strong>{snapshot.identity.name}</strong> — a {snapshot.identity.form}.
            </p>
            <p>{snapshot.identity.temperament}</p>
            <p className="who">Since {formatDate(snapshot.identity.createdAt)}</p>
          </section>

          <section className="memory-section">
            <h2>Episodic — conversations</h2>
            <p className="who">
              {snapshot.episodic.conversationCount} conversation
              {snapshot.episodic.conversationCount === 1 ? '' : 's'} ·{' '}
              {snapshot.episodic.messageCount} message
              {snapshot.episodic.messageCount === 1 ? '' : 's'}
            </p>
            <ul className="memory-list">
              {snapshot.episodic.conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    className="memory-row"
                    onClick={() => void openConversation(conversation.id)}
                  >
                    {formatDate(conversation.createdAt)} · {conversation.messageCount} message
                    {conversation.messageCount === 1 ? '' : 's'}
                  </button>
                  {openConversationId === conversation.id && (
                    <ul className="transcript">
                      {transcript.map((message) => (
                        <li key={message.id} className={`line ${message.role}`}>
                          <span className="who">
                            {message.role === 'user' ? 'You' : snapshot.identity.name}
                          </span>
                          <span className="content">{message.content}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <PlannedSection
            title="Semantic — knowledge from sources"
            phase={snapshot.semantic.plannedPhase}
          />
          <PlannedSection
            title="Procedural — learned skills & workflows"
            phase={snapshot.procedural.plannedPhase}
          />
        </div>
      )}
    </main>
  );
}

interface PlannedSectionProps {
  readonly title: string;
  readonly phase: string;
}

/** A designed-but-unbuilt memory kind, shown so the full shape is visible. */
function PlannedSection({ title, phase }: PlannedSectionProps): JSX.Element {
  return (
    <section className="memory-section planned">
      <h2>{title}</h2>
      <p className="who">Coming soon · planned for {phase}</p>
    </section>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}
