import XCTest

/// Drives the real app against the live Firebase project (agent-9d7c2): signs in
/// with the Email/Password test user, then captures screenshots of the actual
/// (post-login) UI so the design can be reviewed outside the login wall.
///
/// Credentials are injected via launch environment so they are not hard-coded in
/// the bundle. Provide them when running, e.g.:
///   GHOST_UITEST_EMAIL / GHOST_UITEST_PASSWORD
final class GhostAgentUITests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testFirebaseLoginShowsDesignedApp() throws {
        let email = ProcessInfo.processInfo.environment["GHOST_UITEST_EMAIL"] ?? ""
        let password = ProcessInfo.processInfo.environment["GHOST_UITEST_PASSWORD"] ?? ""
        try XCTSkipIf(email.isEmpty || password.isEmpty, "Set GHOST_UITEST_EMAIL / GHOST_UITEST_PASSWORD to run")

        let app = XCUIApplication()
        app.launchArguments += ["-uiTestExpandFirebase"]
        app.launch()

        attach(app, name: "01-login")

        let emailField = app.textFields["firebase-email-field"]
        XCTAssertTrue(emailField.waitForExistence(timeout: 20), "Firebase email field never appeared")
        emailField.tap()
        emailField.typeText(email)

        let passwordField = app.secureTextFields["firebase-password-field"]
        XCTAssertTrue(passwordField.waitForExistence(timeout: 5))
        passwordField.tap()
        passwordField.typeText(password)

        app.buttons["firebase-sign-in-button"].tap()

        // Main shell replaces the login view: the sign-in button disappears.
        let signInButton = app.buttons["sign-in-button"]
        XCTAssertTrue(
            signInButton.waitForNonExistence(timeout: 30),
            "Still on login screen — Firebase exchange did not complete"
        )

        // Give the dashboard a beat to load its first data, then capture it.
        sleep(4)
        attach(app, name: "02-dashboard")

        // Navigate to the API Keys (settings) step, which renders the Firebase
        // diagnostics card showing the connected project.
        let settingsTab = app.buttons["API Keys"]
        if settingsTab.waitForExistence(timeout: 5) {
            settingsTab.tap()
            sleep(2)
            attach(app, name: "03-settings-diagnostics")
        }
    }

    private func attach(_ app: XCUIApplication, name: String) {
        let shot = app.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

private extension XCUIElement {
    func waitForNonExistence(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !exists { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        return !exists
    }
}
