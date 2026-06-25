import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            if model.session == nil {
                LoginView()
            } else {
                MainShellView()
            }
        }
        .overlay(alignment: .bottom) {
            if model.session != nil, let message = model.errorMessage {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(BrandTheme.ColorToken.danger)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .brandGlassChrome()
                    .padding()
                    .accessibilityIdentifier("error-banner")
                    .accessibilityLabel("Error: \(message)")
            }
        }
    }
}

private struct MainShellView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            ZStack {
                BrandBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        sidebarHeader
                        workflowRail
                        miniStats
                        pageHeader
                        activePanel
                    }
                    .padding(BrandTheme.Spacing.screen)
                }
                .refreshable {
                    Feedback.impact()
                    await model.refreshAll()
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .environment(\.layoutDirection, model.lang == .he ? .rightToLeft : .leftToRight)
        .preferredColorScheme(model.theme == .dark ? .dark : .light)
    }

    private var sidebarHeader: some View {
        BrandCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .center, spacing: 12) {
                    BrandMark(size: 50, showsWordmark: false)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("GHOST Agent Builder")
                            .font(.headline.weight(.black))
                        Text(model.t("brandSub"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        Task { await model.logout() }
                    } label: {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                            .frame(width: 40, height: 40)
                    }
                    .foregroundStyle(BrandTheme.ColorToken.danger)
                    .accessibilityLabel(model.t.g("login", "logout"))
                }

                HStack(spacing: 10) {
                    Picker("Language", selection: bind(\.lang)) {
                        ForEach(Lang.allCases) { lang in
                            Text(lang.shortLabel).tag(lang)
                        }
                    }
                    .pickerStyle(.segmented)

                    Button {
                        model.theme = model.theme == .dark ? .light : .dark
                    } label: {
                        Image(systemName: model.theme == .dark ? "sun.max" : "moon")
                            .frame(width: 42, height: 34)
                    }
                    .brandGlassChrome()
                    .accessibilityLabel("Theme")
                }
            }
        }
    }

    private var workflowRail: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(model.t("workflow"))
                .font(.caption2.weight(.black))
                .foregroundStyle(.secondary)
                .tracking(1.4)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(StepKey.allCases) { step in
                        Button {
                            Feedback.impact()
                            model.setActive(step)
                        } label: {
                            HStack(spacing: 8) {
                                Text(step.number)
                                    .font(.caption.weight(.black))
                                    .frame(width: 24, height: 24)
                                    .background(model.active == step ? BrandTheme.ColorToken.accent : BrandTheme.ColorToken.background, in: RoundedRectangle(cornerRadius: 7))
                                Image(systemName: step.icon)
                                Text(title(for: step))
                                    .font(.caption.weight(.heavy))
                            }
                            .padding(.horizontal, 11)
                            .padding(.vertical, 10)
                            .foregroundStyle(model.active == step ? .primary : .secondary)
                            .background(model.active == step ? BrandTheme.ColorToken.panelElevated : BrandTheme.ColorToken.panel, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .stroke(model.active == step ? BrandTheme.ColorToken.line : .clear, lineWidth: 1)
                            }
                        }
                    }
                }
            }
        }
    }

    private var miniStats: some View {
        HStack(spacing: 8) {
            MiniStat(value: count("sources"), title: model.t("miniSources"))
            MiniStat(value: count("agent_skills"), title: model.t("miniSkills"))
            MiniStat(value: count("projects"), title: model.t("miniProjects"))
        }
    }

    private var pageHeader: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                Text("\(model.t("step")) \(model.active.number == "•" ? "—" : model.active.number)")
                    .font(.caption.weight(.black))
                    .foregroundStyle(BrandTheme.ColorToken.accent)
                    .tracking(1.4)
                Text(title(for: model.active))
                    .font(.system(.title, design: .rounded).weight(.black))
                Text(hint(for: model.active))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                Task { await model.refreshAll() }
            } label: {
                Label(model.t("refresh"), systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .tint(BrandTheme.ColorToken.accent)
        }
    }

    @ViewBuilder
    private var activePanel: some View {
        switch model.active {
        case .overview: OverviewParityPanel()
        case .sources: SourcesParityPanel()
        case .skills: SkillsParityPanel()
        case .projects: ProjectsParityPanel()
        case .ask: AskParityPanel()
        case .design: DesignParityPanel()
        case .plan: PlanParityPanel()
        case .build: BuildParityPanel()
        case .memory: MemoryParityPanel()
        case .settings: SettingsParityPanel()
        }
    }

    private func count(_ key: String) -> String {
        guard let value = model.stats?.object("counts")?[key]?.stringValue else { return "—" }
        return value
    }

    private func title(for step: StepKey) -> String {
        model.t.g("stepTitle", step.rawValue)
    }

    private func hint(for step: StepKey) -> String {
        model.t.g("stepHint", step.rawValue)
    }

    private func bind<Value>(_ keyPath: ReferenceWritableKeyPath<AppModel, Value>) -> Binding<Value> {
        Binding(get: { model[keyPath: keyPath] }, set: { model[keyPath: keyPath] = $0 })
    }
}

private struct MiniStat: View {
    let value: String
    let title: String

    var body: some View {
        BrandCard(padding: 10) {
            VStack(spacing: 3) {
                Text(value)
                    .font(.title3.weight(.black).monospacedDigit())
                Text(title)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
        }
    }
}

#Preview {
    ContentView()
        .environment(AppModel())
}
