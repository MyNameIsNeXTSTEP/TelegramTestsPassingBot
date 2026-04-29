import type { SessionMode, Subject, TestType } from "../shared/index.js";

type FlowStep = "choose-faculty" | "choose-subject" | "choose-test-type" | "choose-mode" | "ready";

export interface BotFlowState {
  step: FlowStep;
  faculty?: string;
  subjectId?: string;
  testType?: TestType;
  mode?: SessionMode;
}

export interface BotFlowPrompt {
  text: string;
  options: string[];
  state: BotFlowState;
}

export function startFlow(subjects: Subject[]): BotFlowPrompt {
  const faculties = sortedUnique(subjects.map((subject) => subject.faculty));
  return {
    text: "Choose your faculty to start practice",
    options: faculties,
    state: { step: "choose-faculty" },
  };
}

export function selectFaculty(
  state: BotFlowState,
  faculty: string,
  subjects: Subject[],
): BotFlowPrompt {
  const availableSubjects = subjects
    .filter((subject) => subject.faculty === faculty)
    .map((subject) => subject.subject);

  return {
    text: "Choose a subject",
    options: sortedUnique(availableSubjects),
    state: { step: "choose-subject", faculty },
  };
}

export function selectSubject(state: BotFlowState, subjectId: string): BotFlowPrompt {
  return {
    text: "Choose test type",
    options: ["exam", "credit"],
    state: {
      step: "choose-test-type",
      faculty: state.faculty,
      subjectId,
    },
  };
}

export function selectTestType(state: BotFlowState, testType: TestType): BotFlowPrompt {
  return {
    text: "Choose mode",
    options: ["single", "pack", "exam-prep"],
    state: {
      step: "choose-mode",
      faculty: state.faculty,
      subjectId: state.subjectId,
      testType,
    },
  };
}

export function selectMode(state: BotFlowState, mode: SessionMode): BotFlowPrompt {
  return {
    text: "Ready to start. Press Start Session.",
    options: ["start-session"],
    state: {
      step: "ready",
      faculty: state.faculty,
      subjectId: state.subjectId,
      testType: state.testType,
      mode,
    },
  };
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
