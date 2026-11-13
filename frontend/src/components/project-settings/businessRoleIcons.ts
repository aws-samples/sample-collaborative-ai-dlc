import {
  BugOff,
  CalendarCog,
  ChartNoAxesCombined,
  CodeXml,
  DraftingCompass,
  Lightbulb,
  LockKeyhole,
  Palette,
  Server,
  Tag,
  type LucideIcon,
} from 'lucide-react';

// Keyed by the stable IDs in lambda/shared/business-roles.js. Unknown IDs use
// the fallback so chips keep rendering if the catalog grows first.
const BUSINESS_ROLE_ICONS: Record<string, LucideIcon> = {
  'product-owner': Lightbulb,
  'business-analyst': ChartNoAxesCombined,
  architect: DraftingCompass,
  'ux-ui-designer': Palette,
  developer: CodeXml,
  'qa-tester': BugOff,
  'security-compliance': LockKeyhole,
  'operations-devops': Server,
  'delivery-manager': CalendarCog,
};

export const businessRoleIcon = (id: string): LucideIcon => BUSINESS_ROLE_ICONS[id] ?? Tag;
