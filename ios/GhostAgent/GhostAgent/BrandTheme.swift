import SwiftUI
#if os(iOS)
import UIKit
#endif

enum BrandTheme {
    enum ColorToken {
        static let background = Color("BrandBackground")
        static let panel = Color("BrandPanel")
        static let panelElevated = Color("BrandPanelElevated")
        static let line = Color("BrandLine")
        static let accent = Color("BrandAccent")
        static let accentSecondary = Color("BrandAccentSecondary")
        static let ok = Color("BrandOK")
        static let warn = Color("BrandWarn")
        static let danger = Color("BrandDanger")
    }

    enum Radius {
        static let card: CGFloat = 24
        static let control: CGFloat = 16
        static let chip: CGFloat = 999
    }

    enum Spacing {
        static let screen: CGFloat = 20
        static let card: CGFloat = 16
        static let stack: CGFloat = 12
    }

    static let accentGradient = LinearGradient(
        colors: [ColorToken.accent, ColorToken.accentSecondary],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
}

struct BrandBackground: View {
    var body: some View {
        ZStack {
            BrandTheme.ColorToken.background
            RadialGradient(
                colors: [
                    BrandTheme.ColorToken.accent.opacity(0.30),
                    BrandTheme.ColorToken.accentSecondary.opacity(0.12),
                    .clear
                ],
                center: .topLeading,
                startRadius: 10,
                endRadius: 520
            )
            RadialGradient(
                colors: [
                    BrandTheme.ColorToken.accentSecondary.opacity(0.20),
                    .clear
                ],
                center: .bottomTrailing,
                startRadius: 40,
                endRadius: 460
            )
        }
        .ignoresSafeArea()
    }
}

struct BrandCard<Content: View>: View {
    var padding: CGFloat = BrandTheme.Spacing.card
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .background(BrandTheme.ColorToken.panel.opacity(0.92), in: RoundedRectangle(cornerRadius: BrandTheme.Radius.card, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: BrandTheme.Radius.card, style: .continuous)
                    .stroke(BrandTheme.ColorToken.line.opacity(0.85), lineWidth: 1)
            }
    }
}

struct StatusChip: View {
    let title: String
    let systemImage: String
    let color: Color

    var body: some View {
        Label(title, systemImage: systemImage)
            .font(.caption.weight(.heavy))
            .foregroundStyle(color)
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(color.opacity(0.14), in: Capsule())
            .overlay {
                Capsule().stroke(color.opacity(0.35), lineWidth: 1)
            }
            .accessibilityLabel(title)
    }
}

struct PrimaryBrandButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var isProminent = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.heavy))
            .frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(isProminent ? Color(red: 0.03, green: 0.07, blue: 0.17) : BrandTheme.ColorToken.accent)
            .background {
                if isProminent {
                    Capsule().fill(BrandTheme.accentGradient)
                } else {
                    Capsule().fill(BrandTheme.ColorToken.panelElevated)
                }
            }
            .overlay {
                Capsule().stroke(BrandTheme.ColorToken.line.opacity(isProminent ? 0 : 0.9), lineWidth: 1)
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(reduceMotion ? nil : .bouncy(duration: 0.28, extraBounce: 0.12), value: configuration.isPressed)
    }
}

extension View {
    @ViewBuilder
    func brandGlassChrome() -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular, in: RoundedRectangle(cornerRadius: BrandTheme.Radius.control, style: .continuous))
        } else {
            self.background(.regularMaterial, in: RoundedRectangle(cornerRadius: BrandTheme.Radius.control, style: .continuous))
        }
    }
}

enum Feedback {
    static func impact() {
        #if os(iOS)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }

    static func success() {
        #if os(iOS)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
    }

    static func error() {
        #if os(iOS)
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        #endif
    }
}
