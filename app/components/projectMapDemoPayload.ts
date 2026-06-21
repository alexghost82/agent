// Demo / dev fallback payload for the Project Intelligence Map.
//
// This is ONLY for previewing the workspace in development or an empty state —
// it must never be substituted for a real scan result. It mirrors the shape
// served by `GET /projects/:id/scan/map` so the UI can be exercised offline.

import type { ProjectMapData } from "./ProjectMap";

export const PROJECT_MAP_DEMO: ProjectMapData = {
  scanId: "demo-scan",
  status: "completed",
  generatedAt: Date.now(),
  summary:
    "Demo workspace: a small full-stack app with a React frontend, an Express API, a Firestore data layer, an auth/security service and a Firebase deploy config. Use it to preview layers, search, filters and the Read more detail drawer.",
  stats: { files: 7, nodes: 6, edges: 6, risks: 1, technologies: 5 },
  technologies: [
    { id: "t-react", name: "React", category: "frontend", confidence: "high" },
    { id: "t-express", name: "Express", category: "backend", confidence: "high" },
    { id: "t-firestore", name: "Firestore", category: "database", confidence: "high" },
    { id: "t-firebase", name: "Firebase", category: "deploy", confidence: "high" },
    { id: "t-ts", name: "TypeScript", category: "language", confidence: "high" }
  ],
  features: [
    { id: "f-auth", key: "auth", label: "Authentication", description: "Sign-in and session handling", confidence: "high" },
    { id: "f-projects", key: "projects", label: "Projects", description: "CRUD for user projects", confidence: "high" }
  ],
  dependencies: [
    { name: "react", category: "frontend", usedBy: 3 },
    { name: "express", category: "backend", usedBy: 2 },
    { name: "firebase-admin", category: "database", usedBy: 2 }
  ],
  risks: [
    {
      id: "r-secret",
      title: "Possible secret in config",
      severity: "warning",
      detail: "deploy/firebase.json references an inline key — move it to an encrypted secret.",
      nodeIds: ["deploy-config"]
    }
  ],
  insights: [
    {
      id: "r-secret",
      kind: "secret_risk",
      severity: "warning",
      title: "Possible secret in config",
      detail: "deploy/firebase.json references an inline key — move it to an encrypted secret.",
      confidence: "medium",
      nodeIds: ["deploy-config"]
    }
  ],
  fileIndex: [
    { path: "app/components/Dashboard.tsx", size: 2400, language: "tsx", role: "component" },
    { path: "server/routes/projects.ts", size: 1800, language: "ts", role: "route" },
    { path: "server/services/authService.ts", size: 1600, language: "ts", role: "service" },
    { path: "server/data/firestore.ts", size: 900, language: "ts", role: "store" },
    { path: "deploy/firebase.json", size: 300, language: "json", role: "config" },
    { path: "package.json", size: 600, language: "json", role: "config" },
    { path: "README.md", size: 1200, language: "markdown", role: "doc" }
  ],
  groups: [],
  nodes: [
    {
      id: "project-root",
      type: "project",
      label: "Demo App",
      confidence: "high",
      layers: ["overview", "architecture"],
      position: { x: 0, y: 120 },
      description: "Root of the demo application.",
      details: {
        purpose: "Root of the demo application graph.",
        stack: ["TypeScript", "React", "Express", "Firestore"],
        inputs: [],
        outputs: ["owns → Frontend", "owns → API", "owns → Auth service"],
        logic: "Owns features and top-level modules.",
        files: ["package.json", "README.md"]
      }
    },
    {
      id: "frontend-dashboard",
      type: "component",
      label: "Dashboard.tsx",
      confidence: "high",
      layers: ["overview", "architecture", "code", "uiFlow"],
      position: { x: 340, y: 0 },
      description: "Frontend dashboard screen.",
      tags: ["ui", "react"],
      files: ["app/components/Dashboard.tsx"],
      details: {
        purpose: "Renders the main dashboard and calls the projects API.",
        stack: ["tsx", "React"],
        inputs: ["renders ← Demo App"],
        outputs: ["calls → projects route"],
        logic: "Renders part of the UI.",
        files: ["app/components/Dashboard.tsx"]
      }
    },
    {
      id: "api-projects",
      type: "apiRoute",
      label: "projects.ts",
      confidence: "high",
      layers: ["overview", "architecture", "code", "dataFlow"],
      position: { x: 680, y: 0 },
      description: "Projects REST route.",
      tags: ["api", "express"],
      files: ["server/routes/projects.ts"],
      details: {
        purpose: "Handles CRUD requests for projects.",
        stack: ["ts", "Express"],
        inputs: ["calls ← Dashboard.tsx"],
        outputs: ["uses → Auth service", "reads from db → projects"],
        logic: "Handles an inbound request and returns a response.",
        files: ["server/routes/projects.ts"]
      }
    },
    {
      id: "auth-service",
      type: "service",
      label: "authService.ts",
      confidence: "high",
      layers: ["overview", "architecture", "code", "risk"],
      position: { x: 680, y: 160 },
      hasRisk: false,
      description: "Authentication / security service.",
      tags: ["auth", "security"],
      files: ["server/services/authService.ts"],
      details: {
        purpose: "Verifies sessions and authorizes requests.",
        stack: ["ts"],
        inputs: ["uses ← projects route"],
        outputs: [],
        logic: "Encapsulates auth business logic.",
        files: ["server/services/authService.ts"]
      }
    },
    {
      id: "data-firestore",
      type: "firestoreCollection",
      label: "projects",
      confidence: "high",
      layers: ["overview", "architecture", "dataFlow"],
      position: { x: 1020, y: 0 },
      description: "Firestore projects collection.",
      tags: ["data", "firestore"],
      files: ["server/data/firestore.ts"],
      details: {
        purpose: "Stores project documents.",
        stack: ["Firestore"],
        inputs: ["reads from db ← projects route"],
        outputs: [],
        logic: "A Firestore collection read from / written to by code.",
        files: ["server/data/firestore.ts"]
      }
    },
    {
      id: "deploy-config",
      type: "config",
      label: "firebase.json",
      confidence: "high",
      layers: ["overview", "architecture", "risk"],
      position: { x: 1020, y: 200 },
      hasRisk: true,
      description: "Firebase deploy configuration.",
      tags: ["deploy", "config"],
      files: ["deploy/firebase.json"],
      details: {
        purpose: "Configures Firebase hosting + functions deployment.",
        stack: ["json"],
        inputs: [],
        outputs: [],
        logic: "Configures build, runtime or deployment behaviour.",
        risks: ["Possible secret in config: move inline key to an encrypted secret."],
        files: ["deploy/firebase.json"]
      }
    }
  ],
  edges: [
    { id: "e-1", source: "project-root", target: "frontend-dashboard", type: "owns", label: "owns", layers: ["overview", "architecture"] },
    { id: "e-2", source: "project-root", target: "api-projects", type: "owns", label: "owns", layers: ["overview", "architecture"] },
    { id: "e-3", source: "frontend-dashboard", target: "api-projects", type: "calls", label: "calls", layers: ["overview", "architecture", "dataFlow"] },
    { id: "e-4", source: "api-projects", target: "auth-service", type: "uses", label: "uses", layers: ["architecture", "code"] },
    { id: "e-5", source: "api-projects", target: "data-firestore", type: "reads_from_db", label: "reads from db", layers: ["architecture", "dataFlow"] },
    { id: "e-6", source: "project-root", target: "deploy-config", type: "configured_by", label: "configured by", layers: ["overview", "architecture"] }
  ]
};

export default PROJECT_MAP_DEMO;
