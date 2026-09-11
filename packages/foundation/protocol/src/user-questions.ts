/** Shared data contract; live question ownership belongs to the Bun runtime. */
export interface UserQuestion {
  id: string;
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multi_select?: boolean;
}

export interface UserQuestionAnswer {
  id: string;
  /** An empty selection without custom text means the user explicitly skipped the question. */
  selected: string[];
  custom?: string;
}

export interface PendingUserQuestion {
  request_id: string;
  session_id: string;
  turn_id: string;
  tool_call_id: string;
  questions: UserQuestion[];
}

export interface SubmitUserQuestionAnswer {
  session_id: string;
  request_id: string;
  answers: UserQuestionAnswer[];
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
};
const text = (value: unknown, field: string, max = 8192): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${field} must be non-empty text of at most ${max} characters`);
  }
  return value.trim();
};

export function parseUserQuestions(value: unknown): UserQuestion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new Error("questions must contain between 1 and 3 questions");
  }
  const ids = new Set<string>();
  return value.map(raw => {
    const item = object(raw);
    const id = text(item.id, "question id", 100);
    if (ids.has(id)) throw new Error(`Duplicate question id: ${id}`);
    ids.add(id);
    if (item.multi_select !== undefined && typeof item.multi_select !== "boolean") throw new Error("multi_select must be a boolean");
    let options: UserQuestion["options"];
    if (item.options !== undefined) {
      if (!Array.isArray(item.options) || item.options.length < 1 || item.options.length > 8) throw new Error("options must contain between 1 and 8 choices");
      const labels = new Set<string>();
      options = item.options.map(rawOption => {
        const option = object(rawOption);
        const label = text(option.label, "option label", 300);
        if (labels.has(label)) throw new Error(`Duplicate option label: ${label}`);
        labels.add(label);
        return { label, ...(option.description === undefined ? {} : { description: text(option.description, "option description") }) };
      });
    }
    return {
      id, question: text(item.question, "question"),
      ...(item.header === undefined ? {} : { header: text(item.header, "header", 100) }),
      ...(options === undefined ? {} : { options }),
      ...(item.multi_select === undefined ? {} : { multi_select: item.multi_select }),
    };
  });
}

/** Structural validation at the IPC boundary; membership is checked by the owner. */
export function parseUserQuestionSubmission(value: unknown): SubmitUserQuestionAnswer {
  const input = object(value);
  if (!Array.isArray(input.answers) || input.answers.length < 1 || input.answers.length > 3) throw new Error("answers must contain between 1 and 3 answers");
  return {
    session_id: text(input.session_id, "session_id", 200),
    request_id: text(input.request_id, "request_id", 200),
    answers: input.answers.map(raw => {
      const answer = object(raw);
      if (!Array.isArray(answer.selected) || answer.selected.length > 8) throw new Error("selected must be an array of at most 8 labels");
      return {
        id: text(answer.id, "answer id", 100),
        selected: answer.selected.map(label => text(label, "selected label", 300)),
        ...(answer.custom === undefined ? {} : { custom: text(answer.custom, "custom answer") }),
      };
    }),
  };
}

export function validateUserQuestionAnswers(questions: readonly UserQuestion[], answers: readonly UserQuestionAnswer[]): UserQuestionAnswer[] {
  const byId = new Map(answers.map(answer => [answer.id, answer]));
  if (answers.length !== questions.length || byId.size !== questions.length || questions.some(q => !byId.has(q.id))) {
    throw new Error("Answer each question exactly once using its question id");
  }
  return questions.map(question => {
    const answer = byId.get(question.id)!;
    const choices = new Set(question.options?.map(option => option.label) ?? []);
    if (new Set(answer.selected).size !== answer.selected.length || answer.selected.some(label => !choices.has(label))) {
      throw new Error(`Invalid selected options for question: ${question.id}`);
    }
    if (answer.custom !== undefined) text(answer.custom, "custom answer");
    if (!question.multi_select && answer.selected.length + (answer.custom ? 1 : 0) > 1) {
      throw new Error(`Question ${question.id} accepts one selection or a custom answer`);
    }
    return { ...answer, selected: [...choices].filter(label => answer.selected.includes(label)) };
  });
}
