import { useMemo, useState } from "react";
import { useApprovalStore } from "@/stores/approval-store";
import type { RuntimeRequest } from "@/runtime/types";

export function ApprovalDialog() {
  const pending = useApprovalStore((state) => state.pending);
  const respond = useApprovalStore((state) => state.respond);
  const request = useMemo(() => Object.values(pending)[0] ?? null, [pending]);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  if (!request) return null;

  const isUserInput = request.method === "item/tool/requestUserInput";

  const closeAsDeny = () => {
    void respond(request.requestId, {
      decision: "deny",
      persistence: null,
      answers: {},
    });
  };

  return (
    <div
      className="pointer-events-auto absolute inset-0 z-20 flex items-end justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Runtime approval"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeAsDeny();
        }
      }}
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-background p-4 shadow-2xl">
        <div className="mb-2 text-muted-foreground text-xs uppercase tracking-wide">
          {request.runtime} approval
        </div>
        <h3 className="mb-2 font-semibold text-foreground text-sm">
          {request.title}
        </h3>
        <RequestDetails request={request} />
        {isUserInput && (
          <div className="mt-3 space-y-2">
            {request.questions.map((question) => (
              <div key={question.id} className="block text-xs">
                <label
                  htmlFor={`approval-q-${question.id}`}
                  className="mb-1 block text-muted-foreground"
                >
                  {question.prompt}
                </label>
                {question.options.length > 0 ? (
                  <select
                    id={`approval-q-${question.id}`}
                    className="w-full rounded-md border border-border bg-background px-2 py-1"
                    value={answers[question.id] ?? ""}
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Select…</option>
                    {question.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={`approval-q-${question.id}`}
                    className="w-full rounded-md border border-border bg-background px-2 py-1"
                    value={answers[question.id] ?? ""}
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }))
                    }
                  />
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs"
            onClick={closeAsDeny}
          >
            Deny
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-xs"
            onClick={() =>
              void respond(request.requestId, {
                decision: "cancel",
                persistence: null,
                answers: {},
              })
            }
          >
            Cancel turn
          </button>
          {!isUserInput && (
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-xs"
              onClick={() =>
                void respond(request.requestId, {
                  decision: "allowForSession",
                  persistence: "session",
                  answers: {},
                })
              }
            >
              Allow for session
            </button>
          )}
          <button
            type="button"
            className="rounded-md bg-foreground px-3 py-1.5 text-background text-xs"
            onClick={() => {
              if (isUserInput) {
                const mapped: Record<string, string[]> = {};
                for (const question of request.questions) {
                  const value = answers[question.id]?.trim();
                  if (value) mapped[question.id] = [value];
                }
                void respond(request.requestId, {
                  decision: "allow",
                  persistence: "turn",
                  answers: mapped,
                });
                return;
              }
              void respond(request.requestId, {
                decision: "allow",
                persistence: "turn",
                answers: {},
              });
            }}
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}

function RequestDetails({ request }: { request: RuntimeRequest }) {
  return (
    <div className="space-y-1 text-muted-foreground text-xs">
      {request.threadId && <div>Thread: {request.threadId}</div>}
      {request.agentRunId && <div>Agent: {request.agentRunId}</div>}
      {request.command && (
        <pre className="overflow-auto rounded-md bg-muted p-2 text-[11px] text-foreground">
          {request.command}
        </pre>
      )}
      {request.cwd && <div>cwd: {request.cwd}</div>}
      {request.diff && (
        <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px] text-foreground">
          {request.diff}
        </pre>
      )}
      {request.permissions && (
        <pre className="overflow-auto rounded-md bg-muted p-2 text-[11px] text-foreground">
          {JSON.stringify(request.permissions, null, 2)}
        </pre>
      )}
    </div>
  );
}
