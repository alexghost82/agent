# GhostAgent iOS

Native SwiftUI client for the existing Firebase/Cloud Functions backend.

## Firebase setup

Bundle ID:

```text
com.ghostagnt.ghost
```

Use Firebase CLI to register and fetch config:

```bash
npx -y firebase-tools@latest use
npx -y firebase-tools@latest apps:list IOS --project <PROJECT_ID>
npx -y firebase-tools@latest apps:create IOS "Ghost Agent iOS" --bundle-id com.ghostagnt.ghost --project <PROJECT_ID>
npx -y firebase-tools@latest apps:sdkconfig IOS <APP_ID> --project <PROJECT_ID> > GhostAgent/GoogleService-Info.plist
```

`GoogleService-Info.plist` is intentionally not required for compilation. At
runtime the app reports `Missing GoogleService-Info.plist` until local config is
added.

## Build

```bash
xcodegen generate
xcodebuild -list -project GhostAgent.xcodeproj
xcodebuild -scheme GhostAgent -destination 'platform=iOS Simulator,name=iPhone 16' build
xcodebuild -scheme GhostAgent -destination 'platform=iOS Simulator,name=iPhone 16' test
```

## Backend access

The first compatible auth path uses `POST /login` and stores the returned bearer
token in Keychain. Product data is loaded from Cloud Functions endpoints; the app
does not use Firestore client access.
