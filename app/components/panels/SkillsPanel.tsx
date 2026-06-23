"use client";

import { useMemo, useState } from "react";
import type { GhostData } from "../../useGhostData";
import { Json } from "../../api";
import { downloadZip } from "../../zip";
import { Icon } from "../../icons";
import { ResultView } from "../ResultView";
import { MapModal } from "../MapModal";

export function SkillsPanel({ g }: { g: GhostData }) {
  const { t, topics, skills, selectedTopic, setSelectedTopic, loading, output, stats, query } = g;

  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editExample, setEditExample] = useState("");

  // Which skill group's modal is currently open (by categoryId), if any.
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);

  // Group skills by their topic (category). Skills without a known topicId fall
  // under the "Uncategorized" group, which is always ordered last.
  const q = (query || "").trim().toLowerCase();
  const groups = useMemo(() => {
    const NO_CAT = "\u0000__none__";
    const visibleSkills = q
      ? skills.filter((s) =>
          `${String(s.skillName || "")} ${String(s.description || "")}`.toLowerCase().includes(q)
        )
      : skills;
    const map = new Map<string, { categoryId: string; categoryName: string; skills: Json[] }>();
    for (const s of visibleSkills) {
      const topic = topics.find((tp) => String(tp.id) === String(s.topicId));
      const categoryId = topic ? String(topic.id) : NO_CAT;
      const categoryName = topic ? String(topic.name) : t.noCategory;
      let group = map.get(categoryId);
      if (!group) {
        group = { categoryId, categoryName, skills: [] };
        map.set(categoryId, group);
      }
      group.skills.push(s);
    }
    return [...map.values()].sort((a, b) => {
      if (a.categoryId === NO_CAT) return 1;
      if (b.categoryId === NO_CAT) return -1;
      return a.categoryName.localeCompare(b.categoryName);
    });
  }, [skills, topics, t.noCategory, q]);

  // The group whose modal is open. Falls back to null if it no longer exists
  // (e.g. all of its skills were deleted while the modal was open).
  const openGroup = useMemo(
    () => groups.find((grp) => grp.categoryId === openGroupId) ?? null,
    [groups, openGroupId]
  );

  function closeGroup() {
    setOpenGroupId(null);
    setEditId(null);
  }

  function startEdit(s: Json) {
    setEditId(String(s.id));
    setEditName(String(s.skillName || ""));
    setEditDesc(String(s.description || ""));
    setEditExample(String(s.example || ""));
  }
  async function saveEdit(id: string) {
    await g.updateSkill(id, {
      skillName: editName.trim(),
      description: editDesc.trim(),
      example: editExample.trim() || undefined
    });
    setEditId(null);
  }

  function renderSkill(s: Json) {
    const id = String(s.id);
    const delKey = `del-skill-${id}`;
    const editKey = `edit-skill-${id}`;
    if (editId === id) {
      return (
        <li key={id}>
          <label>{t.skillNameLabel}</label>
          <input value={editName} onChange={(e) => setEditName(e.target.value)} />
          <label>{t.descLabel}</label>
          <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} />
          <label>{t.exampleLabel}</label>
          <input value={editExample} onChange={(e) => setEditExample(e.target.value)} />
          <div className="row-actions" style={{ marginTop: 12 }}>
            <button className="primary sm-primary" onClick={() => saveEdit(id)} disabled={!!loading[editKey] || editName.trim().length < 2}>
              {loading[editKey] ? t.saving : t.save}
            </button>
            <button className="ghost sm" onClick={() => setEditId(null)}>
              {t.cancel}
            </button>
          </div>
        </li>
      );
    }
    return (
      <li key={id}>
        <div className="skill-head">
          <b>{String(s.skillName)}</b>
          {s.source === "learned" ? <span className="tag">{t.learnedTag}</span> : null}
        </div>
        <p>{String(s.description)}</p>
        {s.example ? (
          <code className="skill-ex">
            {t.exampleLabel}: {String(s.example)}
          </code>
        ) : null}
        <div className="row-actions" style={{ marginTop: 10 }}>
          <button className="ghost sm" onClick={() => startEdit(s)}>
            <Icon name="edit" /> {t.edit}
          </button>
          <button
            className="ghost sm danger-btn"
            onClick={() => {
              if (confirm(t.confirmDelete)) g.deleteSkill(id);
            }}
            disabled={!!loading[delKey]}
            aria-label={t.delete}
          >
            <Icon name="trash" /> {loading[delKey] ? t.deleting : t.delete}
          </button>
        </div>
      </li>
    );
  }

  // Export the agent's learned skills (and the currently available knowledge
  // snapshot) as a small archive: a structured skills.json plus a readable
  // knowledge.md. A dedicated memory/knowledge list endpoint is not yet exposed
  // client-side, so we include the dashboard stats and leave a `memory` array
  // for a future list to slot into without changing the file shape.
  function exportKnowledge() {
    const exportedAt = new Date().toISOString();
    const exportedSkills = skills.map((s) => ({
      id: s.id,
      skillName: s.skillName,
      description: s.description,
      example: s.example,
      source: s.source,
      topicId: s.topicId
    }));
    const payload = {
      exportedAt,
      skills: exportedSkills,
      knowledge: { stats: stats ?? null, memory: [] as Json[] }
    };
    const md = [
      "# GHOST knowledge export",
      "",
      `_Exported ${exportedAt}_`,
      "",
      `## Skills (${exportedSkills.length})`,
      "",
      ...exportedSkills.map(
        (s) => `- **${String(s.skillName || "")}** — ${String(s.description || "")}`
      )
    ].join("\n");
    downloadZip("ghost-knowledge", [
      { path: "skills.json", content: JSON.stringify(payload, null, 2) },
      { path: "knowledge.md", content: md }
    ]);
  }

  return (
    <section className="panel">
      <div className="explain">{t.skillsExplain}</div>
      <div className="form-card">
        <label>{t.selectTopic}</label>
        <select value={selectedTopic} onChange={(e) => setSelectedTopic(e.target.value)}>
          <option value="">{"\u2014"}</option>
          {topics.map((tp) => (
            <option key={String(tp.id)} value={String(tp.id)}>
              {String(tp.name)}
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => g.extractSkills(selectedTopic)} disabled={loading.skills || !selectedTopic}>
          <Icon name="skills" /> {loading.skills ? t.extracting : t.createSkillFromTopic}
        </button>
      </div>
      <div className="list-head">
        <h3>
          {t.mySkills} ({skills.length})
        </h3>
        <div className="row-actions">
          <button className="ghost sm" onClick={exportKnowledge} disabled={!skills.length}>
            <Icon name="download" /> {t.exportSkills}
          </button>
          <button className="ghost sm" onClick={g.loadSkills}>
            <Icon name="refresh" /> {t.refreshList}
          </button>
        </div>
      </div>
      {skills.length ? (
        <div className="skill-cat-grid" aria-label={t.skillCategories}>
          {groups.map((group) => (
            <button
              key={group.categoryId}
              type="button"
              className="skill-cat-tile"
              onClick={() => setOpenGroupId(group.categoryId)}
              aria-label={`${group.categoryName} (${group.skills.length})`}
            >
              <span className="skill-cat-tile-name">{group.categoryName}</span>
              <span className="skill-cat-tile-count">{group.skills.length}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">{t.noSkills}</p>
      )}
      <MapModal
        open={!!openGroup}
        title={openGroup ? `${openGroup.categoryName} (${openGroup.skills.length})` : ""}
        onClose={closeGroup}
        closeLabel={t.closeMap}
      >
        {openGroup ? (
          <div className="skill-modal-body">
            <ul className="skill-list">{openGroup.skills.map((s) => renderSkill(s))}</ul>
          </div>
        ) : null}
      </MapModal>
      <ResultView k="skills" output={output} loading={loading} t={t} />
    </section>
  );
}
