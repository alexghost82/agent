import SwiftUI

struct BrandMark: View {
    var size: CGFloat = 72
    var showsWordmark = true

    var body: some View {
        HStack(spacing: showsWordmark ? 14 : 0) {
            Image("GhostLogo")
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.30, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: size * 0.30, style: .continuous)
                        .stroke(.white.opacity(0.12), lineWidth: 1)
                }
                .shadow(color: BrandTheme.ColorToken.accent.opacity(0.45), radius: 22, y: 10)
                .accessibilityHidden(true)

            if showsWordmark {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Ghost Agent")
                        .font(.system(.title3, design: .rounded).weight(.black))
                        .foregroundStyle(.primary)
                    Text("Firebase agent builder")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Ghost Agent")
    }
}

#Preview {
    ZStack {
        BrandBackground()
        BrandMark()
    }
}
