import { ContextItem, ToolStatus } from "core";
import { useEffect, useRef, useState } from "react";
import { useSessionId } from "../../../components/mainInput/TipTapEditor/SessionScope";
import { Button } from "../../../components/ui";
import { useAppDispatch } from "../../../redux/hooks";
import { settleAskUserQuestion } from "../../../redux/thunks/sessionTools";

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionItem {
  id: string;
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
}

interface AskUserQuestionProps {
  questions?: QuestionItem[];
  timeout?: number;
  toolCallId: string;
  status: ToolStatus;
  output?: ContextItem[];
}

export function AskUserQuestion({
  questions = [],
  timeout,
  toolCallId,
  status,
  output,
}: AskUserQuestionProps) {
  const dispatch = useAppDispatch();
  const sessionId = useSessionId();
  const [selectedMap, setSelectedMap] = useState<Record<string, string[]>>({});
  const [customMap, setCustomMap] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const settledRef = useRef(false);

  const isInteractive =
    (status === "calling" || status === "generated") && !submitting;

  useEffect(() => {
    if (
      !sessionId ||
      !isInteractive ||
      typeof timeout !== "number" ||
      timeout <= 0 ||
      settledRef.current
    ) {
      return;
    }
    const timer = setTimeout(() => {
      if (settledRef.current) {
        return;
      }
      settledRef.current = true;
      setSubmitting(true);
      void dispatch(
        settleAskUserQuestion({
          sessionId,
          toolCallId,
          resultJson: JSON.stringify({
            cancelled: true,
            timedOut: true,
            answers: [],
          }),
        }),
      );
    }, timeout * 1000);
    return () => clearTimeout(timer);
  }, [dispatch, isInteractive, sessionId, timeout, toolCallId]);

  const toggleOption = (q: QuestionItem, label: string) => {
    if (!isInteractive) {
      return;
    }
    setSelectedMap((prev) => {
      const curr = prev[q.id] ?? [];
      if (q.multiSelect) {
        return {
          ...prev,
          [q.id]: curr.includes(label)
            ? curr.filter((x) => x !== label)
            : [...curr, label],
        };
      }
      return { ...prev, [q.id]: [label] };
    });
  };

  const handleSubmit = (cancelled = false) => {
    if (!sessionId || !isInteractive || settledRef.current) {
      return;
    }
    settledRef.current = true;
    setSubmitting(true);
    const payload = cancelled
      ? { cancelled: true, answers: [] }
      : {
          answers: questions.map((q) => ({
            id: q.id,
            selected: selectedMap[q.id] ?? [],
            ...(customMap[q.id]?.trim()
              ? { custom: customMap[q.id].trim() }
              : {}),
          })),
        };
    void dispatch(
      settleAskUserQuestion({
        sessionId,
        toolCallId,
        resultJson: JSON.stringify(payload),
      }),
    );
  };

  if (!Array.isArray(questions) || questions.length === 0) {
    return null;
  }

  return (
    <div className="border-command-border bg-vsc-input-background my-2 flex flex-col gap-3 rounded-md border p-3 text-xs">
      {questions.map((q) => {
        const selected = selectedMap[q.id] ?? [];
        return (
          <div key={q.id} className="flex flex-col gap-1.5">
            {q.header && (
              <div className="text-description-muted text-[11px] font-semibold uppercase tracking-wide">
                {q.header}
              </div>
            )}
            <div className="text-vsc-foreground whitespace-pre-wrap font-medium">
              {q.question}
            </div>
            <div className="mt-1 flex flex-col gap-1.5">
              {(q.options ?? []).map((opt) => {
                const isSelected = selected.includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    disabled={!isInteractive}
                    onClick={() => toggleOption(q, opt.label)}
                    className={`border-command-border flex flex-col items-start rounded border px-2.5 py-1.5 text-left transition-colors ${
                      isSelected
                        ? "border-blue-500 bg-blue-500/15"
                        : "hover:bg-lightgray/10 bg-transparent"
                    } ${!isInteractive ? "cursor-default opacity-75" : "cursor-pointer"}`}
                  >
                    <span className="font-medium">{opt.label}</span>
                    {opt.description && (
                      <span className="text-description-muted mt-0.5 text-[11px]">
                        {opt.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {q.allowCustom !== false && isInteractive && (
              <input
                type="text"
                placeholder="Custom answer (optional)..."
                value={customMap[q.id] ?? ""}
                onChange={(e) =>
                  setCustomMap((prev) => ({ ...prev, [q.id]: e.target.value }))
                }
                className="border-command-border bg-vsc-background text-vsc-foreground mt-1 rounded border px-2 py-1 text-xs"
              />
            )}
          </div>
        );
      })}
      {isInteractive ? (
        <div className="mt-1 flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleSubmit(true)}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => handleSubmit(false)}
          >
            Submit
          </Button>
        </div>
      ) : (
        output?.[0]?.content && (
          <div className="text-description-muted border-command-border border-t pt-1.5 text-[11px]">
            Submitted: {output[0].content}
          </div>
        )
      )}
    </div>
  );
}
