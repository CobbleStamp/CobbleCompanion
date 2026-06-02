import type { CompanionDto, MessageRole } from '@cobble/shared';
import { useEffect, useRef, useState } from 'react';
import { createConversation, fetchMessages, sendMessage } from '../api/client.js';

interface ChatProps {
  readonly companion: CompanionDto;
  readonly onSignOut: () => void;
}

interface ChatLine {
  readonly role: MessageRole;
  readonly content: string;
}

/** Step 3: hold a persisted, streamed conversation with the companion. */
export function Chat({ companion, onSignOut }: ChatProps): JSX.Element {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const conversation = await createConversation(companion.id);
      setConversationId(conversation.id);
      const history = await fetchMessages(companion.id, conversation.id);
      setLines(history.map((m) => ({ role: m.role, content: m.content })));
    })();
  }, [companion.id]);

  async function onSend(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!conversationId || input.trim().length === 0 || busy) return;
    const content = input.trim();
    setInput('');
    setBusy(true);
    setLines((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: '' }]);

    try {
      for await (const event_ of sendMessage(companion.id, conversationId, content)) {
        if (event_.type === 'token') {
          setLines((prev) => appendToLast(prev, event_.value));
        } else if (event_.type === 'error') {
          setLines((prev) => appendToLast(prev, `\n[${event_.message}]`));
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="chat">
      <header>
        <h1>{companion.name}</h1>
        <button type="button" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <ul className="transcript">
        {lines.map((line, index) => (
          <li key={index} className={`line ${line.role}`}>
            <span className="who">{line.role === 'user' ? 'You' : companion.name}</span>
            <span className="content">{line.content}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={onSend}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Message ${companion.name}…`}
          disabled={!conversationId}
        />
        <button type="submit" disabled={busy || !conversationId}>
          Send
        </button>
      </form>
    </main>
  );
}

function appendToLast(lines: ChatLine[], delta: string): ChatLine[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1]!;
  return [...lines.slice(0, -1), { role: last.role, content: last.content + delta }];
}
