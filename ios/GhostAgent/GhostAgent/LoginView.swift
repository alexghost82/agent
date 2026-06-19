import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var username = ""
    @State private var password = ""
    @State private var firebaseEmail = ""
    @State private var firebasePassword = ""
    @State private var showFirebase = false
    @FocusState private var focusedField: Field?

    private enum Field {
        case username
        case password
        case firebaseEmail
        case firebasePassword
    }

    private var t: Strings { model.t }

    var body: some View {
        ZStack(alignment: .top) {
            LoginBackground()

            GeometryReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        card
                            .frame(maxWidth: 380)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: proxy.size.height)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 24)
                }
                .scrollDismissesKeyboard(.interactively)
            }

            topBar
        }
        .environment(\.layoutDirection, model.lang == .he ? .rightToLeft : .leftToRight)
        .preferredColorScheme(model.theme == .dark ? .dark : .light)
    }

    // MARK: - Card (mirrors the web .login-card)

    private var card: some View {
        VStack(spacing: 0) {
            Image("GhostLogo")
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 64, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(.white.opacity(0.12), lineWidth: 1)
                }
                .shadow(color: BrandTheme.ColorToken.accent.opacity(0.5), radius: 22, y: 6)
                .padding(.bottom, 14)
                .accessibilityHidden(true)

            Text("GHOST Agent Builder")
                .font(.system(size: 22, weight: .bold, design: .rounded))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.center)
                .padding(.bottom, 4)

            Text(t.g("login", "title"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.bottom, 22)

            VStack(alignment: .leading, spacing: 0) {
                fieldLabel(t.g("login", "username"))
                inputField(
                    text: $username,
                    placeholder: "Alex",
                    isSecure: false,
                    field: .username,
                    submitLabel: .next
                ) {
                    focusedField = .password
                }

                fieldLabel(t.g("login", "password"))
                    .padding(.top, 12)
                inputField(
                    text: $password,
                    placeholder: "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}",
                    isSecure: true,
                    field: .password,
                    submitLabel: .go
                ) {
                    submit()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let message = model.errorMessage {
                errorBanner(message)
                    .padding(.top, 12)
            }

            Button(action: submit) {
                HStack(spacing: 8) {
                    if model.isLoading {
                        ProgressView()
                            .tint(Color(red: 0.03, green: 0.07, blue: 0.17))
                        Text(t.g("login", "signingIn"))
                    } else {
                        Text(t.g("login", "signIn"))
                    }
                }
            }
            .buttonStyle(PrimaryBrandButtonStyle())
            .disabled(username.trimmed.isEmpty || password.isEmpty || model.isLoading)
            .opacity(username.trimmed.isEmpty || password.isEmpty ? 0.45 : 1)
            .accessibilityIdentifier("sign-in-button")
            .padding(.top, 20)

            firebaseSection
                .padding(.top, 18)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 32)
        .background(BrandTheme.ColorToken.panel, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(BrandTheme.ColorToken.line, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.35), radius: 40, y: 24)
    }

    // MARK: - Firebase sign-in (ID-token exchange via POST /auth/firebase)

    private var firebaseSection: some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                Rectangle().fill(BrandTheme.ColorToken.line).frame(height: 1)
                Text(t.g("login", "firebaseTitle"))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                    .fixedSize()
                Rectangle().fill(BrandTheme.ColorToken.line).frame(height: 1)
            }

            DisclosureGroup(isExpanded: $showFirebase) {
                VStack(alignment: .leading, spacing: 0) {
                    if model.firebaseStatus == .sdkUnavailable {
                        Text(t.g("login", "firebaseUnavailable"))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 6)
                    } else {
                        fieldLabel(t.g("login", "firebaseEmail"))
                        inputField(
                            text: $firebaseEmail,
                            placeholder: "you@example.com",
                            isSecure: false,
                            field: .firebaseEmail,
                            submitLabel: .next
                        ) {
                            focusedField = .firebasePassword
                        }
                        .keyboardType(.emailAddress)

                        fieldLabel(t.g("login", "firebasePassword"))
                            .padding(.top, 12)
                        inputField(
                            text: $firebasePassword,
                            placeholder: "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}",
                            isSecure: true,
                            field: .firebasePassword,
                            submitLabel: .go
                        ) {
                            submitFirebase()
                        }

                        Button(action: submitFirebase) {
                            Text(t.g("login", "firebaseSignIn"))
                        }
                        .buttonStyle(PrimaryBrandButtonStyle(isProminent: false))
                        .disabled(firebaseEmail.trimmed.isEmpty || firebasePassword.isEmpty || model.isLoading)
                        .accessibilityIdentifier("firebase-sign-in-button")
                        .padding(.top, 16)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Text(t.g("login", "firebaseSignIn"))
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(BrandTheme.ColorToken.accent)
            }
        }
    }

    // MARK: - Top bar (language + theme), mirrors the web .login-top

    private var topBar: some View {
        HStack(spacing: 8) {
            Picker("Language", selection: bind(\.lang)) {
                ForEach(Lang.allCases) { lang in
                    Text(lang.shortLabel).tag(lang)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 150)
            .onChange(of: model.lang) { _, _ in Feedback.impact() }

            Button {
                Feedback.impact()
                model.theme = model.theme == .dark ? .light : .dark
            } label: {
                Image(systemName: model.theme == .dark ? "sun.max.fill" : "moon.fill")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 36, height: 34)
                    .background(BrandTheme.ColorToken.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(BrandTheme.ColorToken.line, lineWidth: 1)
                    }
            }
            .accessibilityLabel("Theme")
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.horizontal, 18)
        .padding(.top, 8)
    }

    // MARK: - Field building blocks (mirror web inputs: label above a bordered field)

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.bold))
            .foregroundStyle(.secondary)
            .padding(.bottom, 6)
    }

    @ViewBuilder
    private func inputField(
        text: Binding<String>,
        placeholder: String,
        isSecure: Bool,
        field: Field,
        submitLabel: SubmitLabel,
        onSubmit: @escaping () -> Void
    ) -> some View {
        Group {
            if isSecure {
                SecureField(placeholder, text: text)
                    .textContentType(.password)
                    .accessibilityIdentifier("password-field")
            } else {
                TextField(placeholder, text: text)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("username-field")
            }
        }
        .font(.subheadline)
        .focused($focusedField, equals: field)
        .submitLabel(submitLabel)
        .onSubmit(onSubmit)
        .padding(.horizontal, 13)
        .padding(.vertical, 11)
        .background(BrandTheme.ColorToken.background, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .stroke(focusedField == field ? BrandTheme.ColorToken.accent : BrandTheme.ColorToken.line, lineWidth: 1)
        }
        .shadow(
            color: focusedField == field ? BrandTheme.ColorToken.accent.opacity(0.35) : .clear,
            radius: 6
        )
        .animation(.easeOut(duration: 0.15), value: focusedField)
    }

    private func errorBanner(_ message: String) -> some View {
        Text(message)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(BrandTheme.ColorToken.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(BrandTheme.ColorToken.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(BrandTheme.ColorToken.danger, lineWidth: 1)
            }
            .accessibilityIdentifier("login-error")
    }

    // MARK: - Actions

    private func submit() {
        guard !username.trimmed.isEmpty, !password.isEmpty, !model.isLoading else { return }
        Feedback.impact()
        focusedField = nil
        Task {
            await model.login(username: username.trimmed, password: password)
            if model.session != nil {
                Feedback.success()
            } else if model.errorMessage != nil {
                Feedback.error()
            }
        }
    }

    private func submitFirebase() {
        guard !firebaseEmail.trimmed.isEmpty, !firebasePassword.isEmpty, !model.isLoading else { return }
        Feedback.impact()
        focusedField = nil
        Task {
            await model.signInWithFirebaseEmail(email: firebaseEmail.trimmed, password: firebasePassword)
            if model.session != nil {
                Feedback.success()
            } else if model.errorMessage != nil {
                Feedback.error()
            }
        }
    }

    private func bind<Value>(_ keyPath: ReferenceWritableKeyPath<AppModel, Value>) -> Binding<Value> {
        Binding(get: { model[keyPath: keyPath] }, set: { model[keyPath: keyPath] = $0 })
    }
}

// MARK: - Background (mirrors the web radial glow over the dark base)

private struct LoginBackground: View {
    var body: some View {
        ZStack {
            BrandTheme.ColorToken.background
            RadialGradient(
                colors: [
                    BrandTheme.ColorToken.accent.opacity(0.20),
                    .clear
                ],
                center: UnitPoint(x: 0.5, y: -0.1),
                startRadius: 10,
                endRadius: 520
            )
        }
        .ignoresSafeArea()
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
