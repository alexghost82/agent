import SwiftUI

/// A living, depth-rich backdrop: a deep base, slowly drifting colored light
/// "orbs", a fine grain overlay and a vignette. This is the app's signature
/// atmosphere — content and glass chrome float above it.
///
/// Motion is gentle and pauses entirely under Reduce Motion.
struct AuroraBackground: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Drift orbs around these anchor points (unit space) with these tints.
    private struct Orb {
        let tint: Color
        let anchor: UnitPoint
        let radius: CGFloat
        let phase: Double
    }

    private var orbs: [Orb] {
        [
            Orb(tint: BrandTheme.ColorToken.accent, anchor: UnitPoint(x: 0.18, y: 0.12), radius: 0.95, phase: 0),
            Orb(tint: BrandTheme.ColorToken.accentSecondary, anchor: UnitPoint(x: 0.86, y: 0.20), radius: 1.05, phase: 1.7),
            Orb(tint: Self.teal, anchor: UnitPoint(x: 0.72, y: 0.86), radius: 0.85, phase: 3.1),
            Orb(tint: BrandTheme.ColorToken.accentSecondary, anchor: UnitPoint(x: 0.10, y: 0.92), radius: 0.78, phase: 4.6)
        ]
    }

    /// A cool teal accent that breaks the generic indigo/violet pairing and
    /// gives the palette a distinctive, intentional third note.
    private static let teal = Color(red: 0.22, green: 0.85, blue: 0.92)

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            let base = max(size.width, size.height)

            TimelineView(.animation(minimumInterval: reduceMotion ? .infinity : 1.0 / 30.0, paused: reduceMotion)) { timeline in
                let t = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate

                ZStack {
                    BrandTheme.ColorToken.background

                    ForEach(orbs.indices, id: \.self) { index in
                        let orb = orbs[index]
                        let drift = drift(for: orb, t: t)

                        Circle()
                            .fill(
                                RadialGradient(
                                    colors: [orb.tint.opacity(0.55), orb.tint.opacity(0.0)],
                                    center: .center,
                                    startRadius: 0,
                                    endRadius: base * orb.radius * 0.5
                                )
                            )
                            .frame(width: base * orb.radius, height: base * orb.radius)
                            .position(
                                x: orb.anchor.x * size.width + drift.width,
                                y: orb.anchor.y * size.height + drift.height
                            )
                            .blur(radius: 60)
                            .blendMode(.screen)
                    }

                    // Top sheen + bottom grounding for depth.
                    LinearGradient(
                        colors: [.white.opacity(0.05), .clear, .black.opacity(0.35)],
                        startPoint: .top,
                        endPoint: .bottom
                    )

                    // Vignette to focus the center.
                    RadialGradient(
                        colors: [.clear, .black.opacity(0.28)],
                        center: .center,
                        startRadius: base * 0.28,
                        endRadius: base * 0.75
                    )
                }
                .compositingGroup()
            }
        }
        .ignoresSafeArea()
        .drawingGroup(opaque: true)
    }

    private func drift(for orb: AuroraBackground.Orb, t: TimeInterval) -> CGSize {
        guard !reduceMotion else { return .zero }
        let amplitude: CGFloat = 26
        let x = CGFloat(sin(t * 0.07 + orb.phase)) * amplitude
        let y = CGFloat(cos(t * 0.05 + orb.phase * 1.3)) * amplitude
        return CGSize(width: x, height: y)
    }
}

#Preview {
    AuroraBackground()
}
