import type { ScannedFile, Feature, Confidence } from "../types";

interface FeatureRule {
  key: string;
  label: string;
  description: string;
  // Matched against the lowercased file path.
  patterns: RegExp[];
}

// Business-feature heuristics. Patterns are deliberately conservative (word-ish
// boundaries) to avoid over-matching (e.g. "user" shouldn't match "useRef").
const FEATURE_RULES: FeatureRule[] = [
  {
    key: "auth",
    label: "Authentication",
    description: "Login, registration, sessions and access control.",
    patterns: [/(^|\/|\.|-)(auth|login|signin|signup|session|oauth|jwt|password|logout)([\/.\-]|$)/]
  },
  {
    key: "billing",
    label: "Billing & Payments",
    description: "Payments, subscriptions, invoices and checkout.",
    patterns: [/(^|\/|\.|-)(billing|payment|stripe|subscription|invoice|checkout|pricing|plan)([\/.\-]|$)/]
  },
  {
    key: "users",
    label: "Users & Profiles",
    description: "User accounts, profiles and membership.",
    patterns: [/(^|\/|\.|-)(users?|profiles?|accounts?|members?)([\/.\-]|$)/]
  },
  {
    key: "dashboard",
    label: "Dashboard & Analytics",
    description: "Dashboards, analytics and metrics.",
    patterns: [/(^|\/|\.|-)(dashboard|analytics|metrics|stats|reports?|insights?)([\/.\-]|$)/]
  },
  {
    key: "notifications",
    label: "Notifications",
    description: "Email, push and in-app notifications.",
    patterns: [/(^|\/|\.|-)(notifications?|notify|emails?|mailer?|push|alerts?)([\/.\-]|$)/]
  },
  {
    key: "admin",
    label: "Admin",
    description: "Administration, moderation and back-office tools.",
    patterns: [/(^|\/|\.|-)(admin|moderation|backoffice)([\/.\-]|$)/]
  },
  {
    key: "projects",
    label: "Projects",
    description: "Project management entities and workflows.",
    patterns: [/(^|\/|\.|-)(projects?|workspaces?)([\/.\-]|$)/]
  },
  {
    key: "integrations",
    label: "Integrations",
    description: "Third-party integrations, webhooks and connectors.",
    patterns: [/(^|\/|\.|-)(integrations?|webhooks?|connectors?|providers?)([\/.\-]|$)/]
  },
  {
    key: "settings",
    label: "Settings",
    description: "User and application settings/preferences.",
    patterns: [/(^|\/|\.|-)(settings?|preferences?)([\/.\-]|$)/]
  },
  {
    key: "api",
    label: "API",
    description: "HTTP API surface: routes, controllers and endpoints.",
    patterns: [/(^|\/)(api|routes?|controllers?|endpoints?)\//]
  },
  {
    key: "database",
    label: "Database",
    description: "Data models, schemas, migrations and repositories.",
    patterns: [/(^|\/)(db|database|models?|entities|schema|migrations?|repositories|repos?)([\/.\-]|$)/, /\.prisma$/]
  },
  {
    key: "jobs",
    label: "Background Jobs",
    description: "Workers, queues, cron jobs and schedulers.",
    patterns: [/(^|\/|\.|-)(workers?|queues?|jobs?|crons?|schedulers?|tasks?)([\/.\-]|$)/]
  }
];

function confidenceFor(fileCount: number, hasDir: boolean): Confidence {
  if (hasDir && fileCount >= 3) return "high";
  if (fileCount >= 3 || hasDir) return "medium";
  return "low";
}

// Detect business features by file-path heuristics. Returns one Feature per
// matched rule with the owning files and a confidence reflecting the evidence.
export function detectFeatures(files: ScannedFile[]): Feature[] {
  const out: Feature[] = [];
  for (const rule of FEATURE_RULES) {
    const matched = new Set<string>();
    let hasDir = false;
    for (const f of files) {
      const lower = f.path.toLowerCase();
      if (rule.patterns.some((p) => p.test(lower))) {
        matched.add(f.path);
        // A directory segment exactly equal to the key is a strong signal.
        if (lower.split("/").some((seg) => seg === rule.key || seg === `${rule.key}s`)) hasDir = true;
      }
    }
    if (matched.size === 0) continue;
    const fileList = Array.from(matched).sort();
    out.push({
      id: `feature-${rule.key}`,
      key: rule.key,
      label: rule.label,
      description: rule.description,
      confidence: confidenceFor(fileList.length, hasDir),
      files: fileList
    });
  }
  return out;
}
