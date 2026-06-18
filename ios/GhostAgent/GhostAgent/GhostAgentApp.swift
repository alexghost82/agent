import SwiftUI

@main
struct GhostAgentApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
                .task {
                    await model.boot()
                }
        }
    }
}
