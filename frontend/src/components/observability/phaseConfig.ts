import type { StageStep } from './StepNode';

export interface PhaseConfig {
  key: 'INCEPTION' | 'CONSTRUCTION' | 'REVIEW' | 'OPERATIONS';
  label: string;
  icon: string;
  headerBg: string;
  headerText: string;
  blockBg: string;
  blockBorder: string;
  mandatoryBg: string;
  conditionalBg: string;
  steps: StageStep[];
  mainSteps: StageStep[];
  subSteps: StageStep[];
}

export type PhaseKey = 'INCEPTION' | 'CONSTRUCTION' | 'REVIEW' | 'OPERATIONS';
export const PHASE_ORDER: PhaseKey[] = ['INCEPTION', 'CONSTRUCTION', 'REVIEW', 'OPERATIONS'];

// Inception — deux rangées comme dans le diagramme
// Rangée principale (mandatory) : Workspace Detection → Requirements Analysis → Workflow Planning → Application Design → Units Generation
// Rangée secondaire (conditional, sous la principale) : Reverse Engineering (sous WD), User Stories (sous RA)
export const INCEPTION_MAIN: StageStep[] = [
  { key: 'workspace_detection',   label: 'Workspace Detection',   mandatory: true  },
  { key: 'requirements_analysis', label: 'Requirements Analysis', mandatory: true  },
  { key: 'workflow_planning',     label: 'Workflow Planning',     mandatory: true  },
  { key: 'application_design',    label: 'Application Design',    mandatory: false },
  { key: 'units_generation',      label: 'Units Generation',      mandatory: false },
];

export const INCEPTION_SUB: StageStep[] = [
  { key: 'reverse_engineering',   label: 'Reverse Engineering',   mandatory: false },
  { key: 'user_stories',          label: 'User Stories',          mandatory: false },
];

// Construction — une seule rangée
export const CONSTRUCTION_STEPS: StageStep[] = [
  { key: 'functional_design',     label: 'Functional Design',     mandatory: false },
  { key: 'nfr_requirements',      label: 'NFR Requirements',      mandatory: false },
  { key: 'nfr_design',            label: 'NFR Design',            mandatory: false },
  { key: 'infrastructure_design', label: 'Infrastructure Design', mandatory: false },
  { key: 'code_generation',       label: 'Code Generation',       mandatory: true  },
  { key: 'build_and_test',        label: 'Build and Test',        mandatory: true  },
];

export const REVIEW_STEPS: StageStep[] = [
  { key: 'code_review', label: 'Code Review', mandatory: true },
  { key: 'pr_approval', label: 'PR Approval', mandatory: true },
];

// steps = toutes les steps (pour comptage), mainSteps/subSteps pour le rendu 2D
export const PHASE_CONFIGS: PhaseConfig[] = [
  {
    key: 'INCEPTION', label: 'INCEPTION PHASE', icon: '🔵',
    headerBg: 'bg-blue-100 dark:bg-blue-950/60', headerText: 'text-blue-800 dark:text-blue-200',
    blockBg: 'bg-blue-50 dark:bg-blue-950/30', blockBorder: 'border-blue-200 dark:border-blue-800',
    mandatoryBg: 'bg-green-200 dark:bg-green-900/60 border-green-400 dark:border-green-600',
    conditionalBg: 'bg-yellow-100 dark:bg-yellow-900/40 border-yellow-400 dark:border-yellow-600 border-dashed',
    steps: [...INCEPTION_MAIN, ...INCEPTION_SUB],
    mainSteps: INCEPTION_MAIN,
    subSteps: INCEPTION_SUB,
  },
  {
    key: 'CONSTRUCTION', label: 'CONSTRUCTION PHASE', icon: '🟢',
    headerBg: 'bg-green-100 dark:bg-green-950/60', headerText: 'text-green-800 dark:text-green-200',
    blockBg: 'bg-green-50 dark:bg-green-950/30', blockBorder: 'border-green-200 dark:border-green-800',
    mandatoryBg: 'bg-green-200 dark:bg-green-900/60 border-green-400 dark:border-green-600',
    conditionalBg: 'bg-yellow-100 dark:bg-yellow-900/40 border-yellow-400 dark:border-yellow-600 border-dashed',
    steps: CONSTRUCTION_STEPS,
    mainSteps: CONSTRUCTION_STEPS,
    subSteps: [],
  },
  {
    key: 'REVIEW', label: 'REVIEW PHASE', icon: '🟣',
    headerBg: 'bg-purple-100 dark:bg-purple-950/60', headerText: 'text-purple-800 dark:text-purple-200',
    blockBg: 'bg-purple-50 dark:bg-purple-950/30', blockBorder: 'border-purple-200 dark:border-purple-800',
    mandatoryBg: 'bg-green-200 dark:bg-green-900/60 border-green-400 dark:border-green-600',
    conditionalBg: 'bg-yellow-100 dark:bg-yellow-900/40 border-yellow-400 dark:border-yellow-600 border-dashed',
    steps: REVIEW_STEPS,
    mainSteps: REVIEW_STEPS,
    subSteps: [],
  },
  {
    key: 'OPERATIONS', label: 'OPERATIONS PHASE', icon: '🟠',
    headerBg: 'bg-orange-100 dark:bg-orange-950/60', headerText: 'text-orange-800 dark:text-orange-200',
    blockBg: 'bg-orange-50 dark:bg-orange-950/30', blockBorder: 'border-orange-200 dark:border-orange-800',
    mandatoryBg: 'bg-green-200 dark:bg-green-900/60 border-green-400 dark:border-green-600',
    conditionalBg: 'bg-yellow-100 dark:bg-yellow-900/40 border-yellow-400 dark:border-yellow-600 border-dashed',
    steps: [],
    mainSteps: [],
    subSteps: [],
  },
];
