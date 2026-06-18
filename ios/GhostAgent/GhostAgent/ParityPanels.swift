import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

private let providerLabels = ["openai": "OpenAI", "gemini": "Gemini"]

struct OverviewParityPanel: View {
    @Environment(AppModel.self) private var model
    @State private var showOnboarding = true

    private let statMap: [(String, StepKey)] = [
        ("topics", .sources),
        ("sources", .sources),
        ("knowledge_chunks", .ask),
        ("agent_skills", .skills),
        ("projects", .projects),
        ("project_decisions", .design),
        ("generated_plans", .plan),
        ("agent_logs", .overview)
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if showOnboarding && model.topics.isEmpty && model.projects.isEmpty {
                BrandCard {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 12) {
                            Image(systemName: "bolt.badge.automatic")
                                .foregroundStyle(.white)
                                .frame(width: 42, height: 42)
                                .background(BrandTheme.accentGradient, in: RoundedRectangle(cornerRadius: 12))
                            VStack(alignment: .leading) {
                                Text(model.t("onboardTitle"))
                                    .font(.headline.weight(.black))
                                Text(model.t("onboardSubtitle"))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        ForEach(Array([model.t("onboardStep1"), model.t("onboardStep2"), model.t("onboardStep3"), model.t("onboardStep4")].enumerated()), id: \.offset) { index, title in
                            HStack {
                                Text("\(index + 1)")
                                    .font(.caption.weight(.black))
                                    .frame(width: 24, height: 24)
                                    .background(BrandTheme.ColorToken.background, in: RoundedRectangle(cornerRadius: 8))
                                Text(title)
                            }
                        }
                        HStack {
                            Button(model.t("onboardStart")) { model.setActive(.sources) }
                                .buttonStyle(PrimaryBrandButtonStyle())
                            Button(model.t("onboardDismiss")) { showOnboarding = false }
                                .buttonStyle(.bordered)
                        }
                    }
                }
            }

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                ForEach(statMap, id: \.0) { key, step in
                    Button {
                        model.setActive(step)
                    } label: {
                        BrandCard {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(model.stats?.object("counts")?[key]?.stringValue ?? "—")
                                    .font(.system(size: 30, weight: .black, design: .rounded).monospacedDigit())
                                Text(model.t.g("statLabels", key))
                                    .font(.caption.weight(.heavy))
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                Text(model.t("recentTitle"))
                    .font(.headline.weight(.black))
                let logs = model.stats?["recentLogs"]?.arrayValue ?? []
                if logs.isEmpty {
                    Text(model.t("noEvents"))
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(logs) { log in
                        BrandCard(padding: 12) {
                            HStack(alignment: .top) {
                                StatusChip(title: log.string("type") ?? log.string("action") ?? "event", systemImage: "waveform.path.ecg", color: BrandTheme.ColorToken.accent)
                                Text(log.string("message") ?? "")
                                    .font(.subheadline)
                            }
                        }
                    }
                }
            }
        }
    }
}

struct SourcesParityPanel: View {
    @Environment(AppModel.self) private var model
    @State private var topicName = ""
    @State private var topicDesc = ""
    @State private var sourceURL = ""
    @State private var sourceTags = ""
    @State private var page = 0

    private let pageSize = 8

    /// Accept several URLs at once: one per line, or comma/space separated.
    private var parsedUrls: [String] {
        sourceURL
            .split(whereSeparator: { $0 == "\n" || $0 == "," || $0 == " " || $0 == "\t" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Explain(model.t("sourcesExplain"))
            BrandCard {
                VStack(alignment: .leading, spacing: 12) {
                    Text(model.t("topicSection")).font(.headline.weight(.black))
                    TextField(model.t("newTopicName"), text: $topicName).textFieldStyle(.roundedBorder)
                    TextField(model.t("newTopicDesc"), text: $topicDesc).textFieldStyle(.roundedBorder)
                    Button {
                        Task {
                            await model.createTopic(name: topicName, description: topicDesc)
                            topicName = ""; topicDesc = ""
                        }
                    } label: { Label(model.t("createTopic"), systemImage: "plus") }
                    .buttonStyle(PrimaryBrandButtonStyle())
                    .disabled(topicName.trimmingCharacters(in: .whitespaces).count < 2)
                }
            }

            BrandCard {
                VStack(alignment: .leading, spacing: 12) {
                    Picker(model.t("selectTopic"), selection: topicBinding) {
                        Text("—").tag("")
                        ForEach(model.topics) { topic in
                            Text(topic.string("name") ?? "Untitled").tag(topic.string("id") ?? "")
                        }
                    }
                    .pickerStyle(.menu)
                    if model.selectedTopic.isEmpty {
                        Text(model.t("topicRequired")).foregroundStyle(.secondary)
                    } else {
                        TextField(model.t("urlLabel"), text: $sourceURL, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                            .lineLimit(3...6)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Text(model.t("urlMultiHint"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        TextField(model.t("tagsLabel"), text: $sourceTags).textFieldStyle(.roundedBorder)
                        Button {
                            let urls = parsedUrls
                            Task {
                                if urls.count > 1 {
                                    await model.addSources(urls: urls, tags: sourceTags)
                                } else {
                                    await model.addSource(url: urls.first ?? sourceURL, tags: sourceTags)
                                }
                                sourceURL = ""; sourceTags = ""
                            }
                        } label: {
                            Label(
                                model.loading.contains("sources")
                                    ? model.t("learning")
                                    : (parsedUrls.count > 1 ? model.t("addSourcesMulti") : model.t("addSource")),
                                systemImage: "plus"
                            )
                        }
                        .buttonStyle(PrimaryBrandButtonStyle())
                        .disabled(model.loading.contains("sources") || parsedUrls.isEmpty)
                    }
                }
            }

            ListBlock(title: "\(model.t("learnedSources")) (\(model.sources.count))", refresh: { Task { await model.loadSources() } }) {
                if model.sources.isEmpty {
                    Text(model.t("noSources")).foregroundStyle(.secondary)
                } else {
                    ForEach(Array(pagedSlice(model.sources, page: page, size: pageSize))) { source in
                        SourceRow(source: source)
                    }
                    PaginationBar(
                        page: min(page, pageCount(model.sources.count, size: pageSize) - 1),
                        pageCount: pageCount(model.sources.count, size: pageSize),
                        onPrev: { page = max(0, page - 1) },
                        onNext: { page = min(pageCount(model.sources.count, size: pageSize) - 1, page + 1) }
                    )
                }
            }
            ResultBox(key: "sources")
        }
    }

    private var topicBinding: Binding<String> {
        Binding(get: { model.selectedTopic }, set: { model.selectTopic($0) })
    }
}

private struct SourceRow: View {
    @Environment(AppModel.self) private var model
    let source: JSONValue
    @State private var confirmDelete = false

    var body: some View {
        BrandCard(padding: 12) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top) {
                    Image(systemName: "link").foregroundStyle(BrandTheme.ColorToken.accent)
                    VStack(alignment: .leading) {
                        Text(source.string("title") ?? source.string("url") ?? "Source")
                            .font(.subheadline.weight(.heavy))
                        Text(source.string("url") ?? "")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    StatusChip(title: "\(source.int("chunkCount") ?? source.int("chunks") ?? 0) \(model.t("chunksUnit"))", systemImage: "text.alignleft", color: BrandTheme.ColorToken.accent)
                }
                HStack {
                    Button(model.t("reingest"), systemImage: "arrow.clockwise") { Task { await model.reingestSource(source) } }
                    Button(model.t("delete"), systemImage: "trash", role: .destructive) { confirmDelete = true }
                }
                .buttonStyle(.bordered)
            }
        }
        .confirmationDialog(model.t("confirmDelete"), isPresented: $confirmDelete, titleVisibility: .visible) {
            Button(model.t("delete"), role: .destructive) {
                if let id = source.string("id") { Task { await model.deleteSource(id) } }
            }
            Button(model.t("cancel"), role: .cancel) {}
        }
    }
}

struct SkillsParityPanel: View {
    @Environment(AppModel.self) private var model
    @State private var editing: JSONValue?
    @State private var editName = ""
    @State private var editDesc = ""
    @State private var editExample = ""
    @State private var page = 0

    private let pageSize = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Explain(model.t("skillsExplain"))
            BrandCard {
                VStack(alignment: .leading, spacing: 12) {
                    Picker(model.t("selectTopic"), selection: Binding(get: { model.selectedTopic }, set: { model.selectTopic($0) })) {
                        Text("—").tag("")
                        ForEach(model.topics) { Text($0.string("name") ?? "Untitled").tag($0.string("id") ?? "") }
                    }
                    Button {
                        Task { await model.extractSkills() }
                    } label: { Label(model.loading.contains("skills") ? model.t("extracting") : model.t("createSkillFromTopic"), systemImage: "bolt.badge.automatic") }
                    .buttonStyle(PrimaryBrandButtonStyle())
                    .disabled(model.loading.contains("skills") || model.selectedTopic.isEmpty)
                }
            }
            ListBlock(title: "\(model.t("mySkills")) (\(model.skills.count))", refresh: { Task { await model.loadSkills() } }) {
                if model.skills.isEmpty {
                    Text(model.t("noSkills")).foregroundStyle(.secondary)
                } else {
                    ForEach(Array(pagedSlice(model.skills, page: page, size: pageSize))) { skill in
                        SkillRow(skill: skill, editing: $editing, editName: $editName, editDesc: $editDesc, editExample: $editExample)
                    }
                    PaginationBar(
                        page: min(page, pageCount(model.skills.count, size: pageSize) - 1),
                        pageCount: pageCount(model.skills.count, size: pageSize),
                        onPrev: { page = max(0, page - 1) },
                        onNext: { page = min(pageCount(model.skills.count, size: pageSize) - 1, page + 1) }
                    )
                }
            }
            ResultBox(key: "skills")
        }
    }
}

private struct SkillRow: View {
    @Environment(AppModel.self) private var model
    let skill: JSONValue
    @Binding var editing: JSONValue?
    @Binding var editName: String
    @Binding var editDesc: String
    @Binding var editExample: String
    @State private var confirmDelete = false

    var isEditing: Bool { editing?.string("id") == skill.string("id") }

    var body: some View {
        BrandCard(padding: 12) {
            if isEditing {
                VStack(alignment: .leading, spacing: 10) {
                    TextField(model.t("skillNameLabel"), text: $editName).textFieldStyle(.roundedBorder)
                    TextField(model.t("descLabel"), text: $editDesc, axis: .vertical).textFieldStyle(.roundedBorder)
                    TextField(model.t("exampleLabel"), text: $editExample).textFieldStyle(.roundedBorder)
                    HStack {
                        Button(model.t("save")) {
                            if let id = skill.string("id") {
                                Task {
                                    await model.updateSkill(id: id, name: editName, description: editDesc, example: editExample)
                                    editing = nil
                                }
                            }
                        }
                        Button(model.t("cancel")) { editing = nil }
                    }
                    .buttonStyle(.bordered)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(skill.string("skillName") ?? "Skill").font(.headline.weight(.black))
                        if skill.string("source") == "learned" {
                            StatusChip(title: model.t("learnedTag"), systemImage: "checkmark", color: BrandTheme.ColorToken.ok)
                        }
                    }
                    Text(skill.string("description") ?? "").font(.subheadline).foregroundStyle(.secondary)
                    if let example = skill.string("example"), !example.isEmpty {
                        Text("\(model.t("exampleLabel")): \(example)")
                            .font(.caption.monospaced())
                            .foregroundStyle(BrandTheme.ColorToken.accent)
                    }
                    HStack {
                        Button(model.t("edit"), systemImage: "pencil") {
                            editing = skill
                            editName = skill.string("skillName") ?? ""
                            editDesc = skill.string("description") ?? ""
                            editExample = skill.string("example") ?? ""
                        }
                        Button(model.t("delete"), systemImage: "trash", role: .destructive) { confirmDelete = true }
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        .confirmationDialog(model.t("confirmDelete"), isPresented: $confirmDelete, titleVisibility: .visible) {
            Button(model.t("delete"), role: .destructive) {
                if let id = skill.string("id") { Task { await model.deleteSkill(id) } }
            }
            Button(model.t("cancel"), role: .cancel) {}
        }
    }
}

private enum ProjectCreateMode: String, CaseIterable, Identifiable {
    case scratch
    case repo
    var id: String { rawValue }
}

struct ProjectsParityPanel: View {
    @Environment(AppModel.self) private var model
    @State private var createMode = ProjectCreateMode.scratch
    @State private var name = ""
    @State private var desc = ""
    @State private var stack = ""
    @State private var repo = ""
    @State private var ghToken = ""
    @State private var tokenSaved = false
    @State private var search = ""
    @State private var page = 0

    private let pageSize = 6

    var filteredSkills: [JSONValue] {
        guard !search.trimmingCharacters(in: .whitespaces).isEmpty else { return model.skills }
        return model.skills.filter {
            "\($0.string("skillName") ?? "") \($0.string("description") ?? "")".localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Explain(model.t("projectExplain"))
            BrandCard {
                VStack(alignment: .leading, spacing: 10) {
                    Picker("Create mode", selection: $createMode) {
                        Text(model.t("createScratchTab")).tag(ProjectCreateMode.scratch)
                        Text(model.t("createRepoTab")).tag(ProjectCreateMode.repo)
                    }
                    .pickerStyle(.segmented)
                    Text(createMode == .scratch ? model.t("createScratchHint") : model.t("repoModeHint"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextField(model.t("nameLabel"), text: $name).textFieldStyle(.roundedBorder)
                    TextField(model.t("stackLabel"), text: $stack).textFieldStyle(.roundedBorder)
                    TextField(model.t("descLabel"), text: $desc, axis: .vertical).textFieldStyle(.roundedBorder)
                    if createMode == .repo {
                        TextField(model.t("repoLabel"), text: $repo)
                            .textFieldStyle(.roundedBorder)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    Button {
                        Task {
                            await model.createProject(
                                name: name,
                                description: desc,
                                stack: stack,
                                repoUrl: createMode == .repo ? repo : ""
                            )
                            name = ""; desc = ""; stack = ""; repo = ""
                        }
                    } label: { Label(createMode == .scratch ? model.t("createScratch") : model.t("createProject"), systemImage: "plus") }
                    .buttonStyle(PrimaryBrandButtonStyle())
                    .disabled(name.count < 2 || desc.count < 5 || model.loading.contains("projectCreate"))
                }
            }
            BrandCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text(model.t("githubSection")).font(.headline.weight(.black))
                    SecureField(model.t("githubTokenLabel"), text: $ghToken)
                        .textFieldStyle(.roundedBorder)
                    Button(model.t("saveToken"), systemImage: "person.badge.key") {
                        Task {
                            await model.saveGithubToken(ghToken)
                            ghToken = ""; tokenSaved = true
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(ghToken.trimmingCharacters(in: .whitespaces).isEmpty)
                    if tokenSaved { Text(model.t("tokenSaved")).font(.caption).foregroundStyle(BrandTheme.ColorToken.ok) }
                }
            }

            ListBlock(title: "\(model.t.g("stepTitle", "projects")) (\(model.projects.count))", refresh: { Task { await model.loadProjects() } }) {
                if model.projects.isEmpty {
                    Text(model.t("noProjects")).foregroundStyle(.secondary)
                } else {
                    ForEach(Array(pagedSlice(model.projects, page: page, size: pageSize))) { ProjectFullRow(project: $0) }
                    PaginationBar(
                        page: min(page, pageCount(model.projects.count, size: pageSize) - 1),
                        pageCount: pageCount(model.projects.count, size: pageSize),
                        onPrev: { page = max(0, page - 1) },
                        onNext: { page = min(pageCount(model.projects.count, size: pageSize) - 1, page + 1) }
                    )
                }
            }

            BrandCard {
                VStack(alignment: .leading, spacing: 12) {
                    Picker(model.t("selectProject"), selection: Binding(get: { model.selectedProject }, set: { model.selectProject($0) })) {
                        Text("—").tag("")
                        ForEach(model.projects) { Text($0.string("name") ?? "Project").tag($0.string("id") ?? "") }
                    }
                    Text(model.t("skillsToUse")).font(.headline.weight(.black))
                    TextField(model.t("searchSkills"), text: $search).textFieldStyle(.roundedBorder)
                    HStack {
                        Button(model.t("selectAll"), systemImage: "checkmark") {
                            let ids = filteredSkills.compactMap { $0.string("id") }
                            model.selectedSkillIds = Array(Set(model.selectedSkillIds + ids))
                        }
                        Button(model.t("clearSel")) { model.selectedSkillIds = [] }
                    }
                    .buttonStyle(.bordered)
                    if filteredSkills.isEmpty {
                        Text(model.skills.isEmpty ? model.t("noSkillsYet") : model.t("noMatches"))
                            .foregroundStyle(.secondary)
                    } else {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(filteredSkills) { skill in
                                Button {
                                    if let id = skill.string("id") { model.toggleSkill(id) }
                                } label: {
                                    HStack {
                                        Image(systemName: model.selectedSkillIds.contains(skill.string("id") ?? "") ? "checkmark.square.fill" : "square")
                                        Text(skill.string("skillName") ?? "Skill")
                                        Spacer()
                                    }
                                }
                                .buttonStyle(.plain)
                                .padding(10)
                                .background(BrandTheme.ColorToken.panelElevated, in: RoundedRectangle(cornerRadius: 10))
                            }
                        }
                    }
                    Button(model.t("saveSkills")) { Task { await model.saveProjectSkills() } }
                        .buttonStyle(PrimaryBrandButtonStyle())
                        .disabled(model.selectedProject.isEmpty)
                }
            }
            ResultBox(key: "projectCreate")
        }
    }
}

private struct ProjectFullRow: View {
    @Environment(AppModel.self) private var model
    let project: JSONValue
    @State private var isEditing = false
    @State private var name = ""
    @State private var desc = ""
    @State private var stack = ""
    @State private var repo = ""
    @State private var confirmDelete = false

    var body: some View {
        BrandCard(padding: 12) {
            if isEditing {
                VStack(alignment: .leading, spacing: 10) {
                    TextField(model.t("nameLabel"), text: $name).textFieldStyle(.roundedBorder)
                    TextField(model.t("stackLabel"), text: $stack).textFieldStyle(.roundedBorder)
                    TextField(model.t("repoLabel"), text: $repo).textFieldStyle(.roundedBorder)
                    TextField(model.t("descLabel"), text: $desc, axis: .vertical).textFieldStyle(.roundedBorder)
                    HStack {
                        Button(model.t("save")) {
                            if let id = project.string("id") {
                                Task {
                                    await model.updateProject(id: id, name: name, description: desc, stack: stack, repoUrl: repo)
                                    isEditing = false
                                }
                            }
                        }
                        Button(model.t("cancel")) { isEditing = false }
                    }
                    .buttonStyle(.bordered)
                }
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading) {
                            Text(project.string("name") ?? "Project").font(.headline.weight(.black))
                            Text("\(project.string("repoUrl") ?? "—") · \(project.int("ingestedFiles") ?? 0) \(model.t("filesIndexed"))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        StatusChip(title: statusLabel, systemImage: "circle.dotted", color: statusColor)
                    }
                    if let summary = project.string("summary"), !summary.isEmpty {
                        Text(summary)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(5)
                    }
                    if project.string("ingestStatus") == "ingesting" {
                        IngestProgress(project: project)
                    }
                    HStack {
                        Button(model.t("connectGithub"), systemImage: "globe") {
                            if let id = project.string("id") {
                                Task { await model.connectGithub(projectId: id, repoUrl: project.string("repoUrl") ?? "") }
                            }
                        }
                        .disabled((project.string("repoUrl") ?? "").isEmpty)
                        Button(model.t("edit"), systemImage: "pencil") {
                            name = project.string("name") ?? ""
                            desc = project.string("description") ?? ""
                            stack = project.string("stack") ?? ""
                            repo = project.string("repoUrl") ?? ""
                            isEditing = true
                        }
                        Button(model.t("delete"), systemImage: "trash", role: .destructive) { confirmDelete = true }
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
        .confirmationDialog(model.t("confirmDelete"), isPresented: $confirmDelete, titleVisibility: .visible) {
            Button(model.t("delete"), role: .destructive) {
                if let id = project.string("id") { Task { await model.deleteProject(id) } }
            }
            Button(model.t("cancel"), role: .cancel) {}
        }
    }

    private var statusLabel: String {
        switch project.string("ingestStatus") ?? "none" {
        case "ready": return model.t("ingest_ready")
        case "ingesting": return model.t("ingest_ingesting")
        case "error": return model.t("ingest_error")
        default: return model.t("ingest_none")
        }
    }

    private var statusColor: Color {
        switch project.string("ingestStatus") ?? "none" {
        case "ready": return BrandTheme.ColorToken.ok
        case "ingesting": return BrandTheme.ColorToken.warn
        case "error": return BrandTheme.ColorToken.danger
        default: return BrandTheme.ColorToken.accent
        }
    }
}

struct AskParityPanel: View {
    @Environment(AppModel.self) private var model
    @State private var question = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Explain(model.t("askExplain"))
            BrandCard {
                VStack(alignment: .leading, spacing: 10) {
                    TextField(model.t("questionLabel"), text: $question, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(4...8)
                    Button {
                        Task { await model.ask(question) }
                    } label: { Text(model.loading.contains("ask") ? model.t("thinking") : model.t("ask")) }
                    .buttonStyle(PrimaryBrandButtonStyle())
                    .disabled(question.trimmingCharacters(in: .whitespaces).count < 3 || model.loading.contains("ask"))
                }
            }
            ResultBox(key: "ask")
        }
    }
}

struct DesignParityPanel: View {
    @Environment(AppModel.self) private var model
    @State private var section = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Explain(model.t("designExplain"))
            ProjectPicker()
            BrandCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text(model.t("ideaLabel"))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                    TextField(
                        model.t("ideaPlaceholder"),
                        text: $section,
                        axis: .vertical
                    )
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(3...8)
                    Button {
                        Task { await model.design(section: section) }
                    } label: { Label(model.loading.contains("design") ? model.t("designing") : model.t("designBtn"), systemImage: "chart.line.uptrend.xyaxis") }
                    .buttonStyle(PrimaryBrandButtonStyle())
                    .disabled(model.selectedProject.isEmpty || model.loading.contains("design"))
                }
            }
            ResultBox(key: "design")
        }
    }
}

struct PlanParityPanel: View {
    @Environment(AppModel.self) private var model
    @State private var instructions = ""

    var plan: JSONValue? { model.output["plan"] }
    var files: [JSONValue] { plan?.array("files") ?? [] }
    var prompts: [JSONValue] { plan?.array("prompts") ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Explain(model.t("planExplain"))
            ProjectPicker()
            BrandCard {
                VStack(alignment: .leading, spacing: 10) {
                    TextField(model.t("instructionsLabel"), text: $instructions, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                    Button {
                        Task { await model.generatePlan(instructions: instructions) }
                    } label: { Label(model.loading.contains("plan") ? model.t("generating") : model.t("generate"), systemImage: "chevron.left.forwardslash.chevron.right") }
                    .buttonStyle(PrimaryBrandButtonStyle())
                    .disabled(model.selectedProject.isEmpty || model.loading.contains("plan"))
                }
            }
            if model.loading.contains("plan") || plan?.object("error") != nil || (files.isEmpty && prompts.isEmpty) {
                ResultBox(key: "plan", emptyText: model.t("noPlanYet"))
            } else {
                if !files.isEmpty {
                    ListBlock(title: "\(model.t("generatedFiles")) (\(files.count))") {
                        ForEach(files) { file in
                            GeneratedBlock(title: file.string("path") ?? "file.md", content: file.string("content") ?? "", shareName: file.string("path") ?? "file.md")
                        }
                    }
                }
                if !prompts.isEmpty {
                    ListBlock(title: "\(model.t("promptsTitle")) (\(prompts.count))") {
                        ForEach(prompts) { prompt in
                            GeneratedBlock(title: prompt.string("title") ?? "Prompt", content: prompt.string("content") ?? "", shareName: "\(prompt.string("title") ?? "prompt").md")
                        }
                    }
                }
            }
        }
    }
}

struct SettingsParityPanel: View {
    @Environment(AppModel.self) private var model
    @State private var openAI = ""
    @State private var gemini = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Explain(model.t("settingsExplain"))
            BrandCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text(model.t("activeProvider")).font(.headline.weight(.black))
                    Picker(model.t("activeProvider"), selection: Binding(get: { model.providerStatus?.provider ?? "openai" }, set: { p in Task { await model.setProvider(p) } })) {
                        Text("OpenAI").tag("openai")
                        Text("Gemini").tag("gemini")
                    }
                    .pickerStyle(.segmented)
                    Text(model.t("activeProviderHint"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            ProviderKeyCard(provider: "openai", input: $openAI)
            ProviderKeyCard(provider: "gemini", input: $gemini)
        }
        .task { await model.loadKeys() }
    }
}

private struct ProviderKeyCard: View {
    @Environment(AppModel.self) private var model
    let provider: String
    @Binding var input: String
    @State private var fieldError = ""

    var status: KeyInfo? { model.providerStatus?.keys[provider] }

    /// Same validation as the web client's KEY_RX (sk- for OpenAI, AIza for Gemini).
    private func isValidFormat(_ raw: String) -> Bool {
        provider == "openai" ? raw.hasPrefix("sk-") : raw.hasPrefix("AIza")
    }

    private func save() {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { fieldError = model.t("keyEnterFirst"); return }
        guard isValidFormat(raw) else {
            fieldError = provider == "openai" ? model.t("keyInvalidOpenai") : model.t("keyInvalidGemini")
            return
        }
        fieldError = ""
        Task {
            await model.saveAPIKey(provider: provider, value: raw)
            input = ""
        }
    }

    var body: some View {
        BrandCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(providerLabels[provider] ?? provider).font(.headline.weight(.black))
                    Spacer()
                    if model.providerStatus?.provider == provider {
                        StatusChip(title: model.t("providerActiveBadge"), systemImage: "checkmark", color: BrandTheme.ColorToken.ok)
                    }
                    StatusChip(
                        title: status?.configured == true ? "\(model.t("statusConfigured")) • ••••\(status?.last4 ?? "")" : model.t("statusNotConfigured"),
                        systemImage: status?.configured == true ? "key.fill" : "key",
                        color: status?.configured == true ? BrandTheme.ColorToken.ok : BrandTheme.ColorToken.warn
                    )
                }
                if status?.configured == true, let updatedAt = status?.updatedAt, !updatedAt.isEmpty {
                    Text("\(model.t("keyUpdatedAt")): \(Self.formatDate(updatedAt))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                SecureField(provider == "openai" ? "sk-…" : "AIza…", text: $input)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: input) { _, _ in if !fieldError.isEmpty { fieldError = "" } }
                if !fieldError.isEmpty {
                    Text(fieldError)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(BrandTheme.ColorToken.danger)
                }
                HStack {
                    Button(model.t("keySaveBtn")) { save() }
                        .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button(model.t("keyTestBtn")) { Task { await model.testAPIKey(provider: provider) } }
                        .disabled(status?.configured != true)
                    Button(model.t("keyRemoveBtn"), role: .destructive) { Task { await model.saveAPIKey(provider: provider, value: nil) } }
                        .disabled(status?.configured != true)
                }
                .buttonStyle(.bordered)
                ResultBox(key: "test-key-\(provider)", emptyText: "")
            }
        }
    }

    private static func formatDate(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}

private struct ProjectPicker: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        BrandCard {
            Picker(model.t("selectProject"), selection: Binding(get: { model.selectedProject }, set: { model.selectProject($0) })) {
                Text("—").tag("")
                ForEach(model.projects) { project in
                    Text(project.string("name") ?? "Project").tag(project.string("id") ?? "")
                }
            }
            .pickerStyle(.menu)
        }
    }
}

private struct Explain: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.primary)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                LinearGradient(
                    colors: [BrandTheme.ColorToken.accent.opacity(0.14), BrandTheme.ColorToken.accentSecondary.opacity(0.08)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ),
                in: RoundedRectangle(cornerRadius: BrandTheme.Radius.control, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: BrandTheme.Radius.control, style: .continuous)
                    .stroke(BrandTheme.ColorToken.line, lineWidth: 1)
            }
    }
}

private struct ListBlock<Content: View>: View {
    @Environment(AppModel.self) private var model
    let title: String
    var refresh: (() -> Void)?
    @ViewBuilder var content: Content

    init(title: String, refresh: (() -> Void)? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.refresh = refresh
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title).font(.headline.weight(.black))
                Spacer()
                if let refresh {
                    Button(model.t("refreshList"), systemImage: "arrow.clockwise") { refresh() }
                        .buttonStyle(.bordered)
                }
            }
            content
        }
    }
}

private struct ResultBox: View {
    @Environment(AppModel.self) private var model
    let key: String
    /// nil -> use the localized default ("Result will appear here."); "" -> render nothing.
    var emptyText: String? = nil

    var data: JSONValue? { model.output[key] }

    var body: some View {
        let empty = emptyText ?? model.t("resultEmpty")
        if model.loading.contains(key) {
            BrandCard {
                HStack {
                    ProgressView()
                    Text(model.t("working"))
                }
                .foregroundStyle(.secondary)
            }
        } else if let error = data?.string("error") {
            BrandCard {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(model.t("errorWord")): \(mappedError(error))")
                        .font(.headline.weight(.black))
                        .foregroundStyle(BrandTheme.ColorToken.danger)
                    if let requestId = data?.string("requestId") {
                        Text("\(model.t("requestId")): \(requestId)")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
            }
        } else if let data {
            let blocks = ["answer", "plan", "design", "result"].compactMap { blockKey -> (String, String)? in
                guard let value = data.string(blockKey) else { return nil }
                return (model.t.g("resultLabels", blockKey), value)
            }
            BrandCard {
                if blocks.isEmpty {
                    Text(Self.pretty(data))
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                } else {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(blocks, id: \.0) { title, content in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(title.uppercased())
                                    .font(.caption.weight(.black))
                                    .foregroundStyle(BrandTheme.ColorToken.accent)
                                Text(content)
                                    .font(.body)
                                    .textSelection(.enabled)
                            }
                        }
                        DisclosureGroup(model.t("showRaw")) {
                            Text(Self.pretty(data))
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                    }
                }
            }
        } else if !empty.isEmpty {
            BrandCard {
                Text(empty)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func mappedError(_ code: String) -> String {
        let mapped = model.t.g("errorCodes", code)
        return mapped == code ? code : mapped
    }

    private static func pretty(_ value: JSONValue) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let object = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let string = String(data: pretty, encoding: .utf8) else {
            return String(describing: value)
        }
        return string
    }
}

private struct GeneratedBlock: View {
    @Environment(AppModel.self) private var model
    let title: String
    let content: String
    let shareName: String

    var body: some View {
        BrandCard(padding: 12) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(title)
                        .font(.subheadline.weight(.black))
                        .foregroundStyle(BrandTheme.ColorToken.accent)
                    Spacer()
                    Button(model.t("copy"), systemImage: "doc.on.doc") {
                        #if os(iOS)
                        UIPasteboard.general.string = content
                        Feedback.success()
                        #endif
                    }
                    .labelStyle(.iconOnly)
                    ShareLink(item: content, preview: SharePreview(shareName))
                }
                Text(content)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .lineLimit(12)
            }
        }
    }
}

// MARK: - Shared parity helpers (pagination, ingest progress)

/// Client-side pagination control, mirrors the web `Pagination` component.
struct PaginationBar: View {
    @Environment(AppModel.self) private var model
    let page: Int
    let pageCount: Int
    let onPrev: () -> Void
    let onNext: () -> Void

    var body: some View {
        if pageCount > 1 {
            HStack {
                Button(model.t("prevPage"), systemImage: "chevron.left", action: onPrev)
                    .disabled(page == 0)
                Spacer()
                Text("\(model.t("pageLabel")) \(page + 1) \(model.t("ofLabel")) \(pageCount)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button(model.t("nextPage"), systemImage: "chevron.right", action: onNext)
                    .disabled(page >= pageCount - 1)
            }
            .buttonStyle(.bordered)
            .tint(BrandTheme.ColorToken.accent)
        }
    }
}

/// Number of pages for `count` items at `size` per page (always >= 1).
func pageCount(_ count: Int, size: Int) -> Int {
    max(1, Int(ceil(Double(count) / Double(size))))
}

/// Stable, clamped slice of `items` for `page`.
func pagedSlice<T>(_ items: [T], page: Int, size: Int) -> ArraySlice<T> {
    let pages = pageCount(items.count, size: size)
    let clamped = min(max(0, page), pages - 1)
    let start = clamped * size
    guard start < items.count else { return items[0..<0] }
    return items[start..<min(start + size, items.count)]
}

/// Live ingest progress bar, mirrors the web `IngestProgress` component.
private struct IngestProgress: View {
    @Environment(AppModel.self) private var model
    let project: JSONValue

    private var done: Int { project.int("ingestedFiles") ?? 0 }
    private var total: Int {
        project.int("ingestTotalFiles") ?? project.int("totalFiles") ?? project.int("ingestTotal") ?? 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("\(model.t("ingestProgress")) — \(done)\(total > 0 ? " / \(total)" : "") \(model.t("filesSoFar"))")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(BrandTheme.ColorToken.warn)
            }
            if total > 0 {
                ProgressView(value: Double(min(done, total)), total: Double(total))
                    .tint(BrandTheme.ColorToken.accent)
            } else {
                ProgressView(value: 0.4)
                    .tint(BrandTheme.ColorToken.accent)
            }
        }
    }
}


