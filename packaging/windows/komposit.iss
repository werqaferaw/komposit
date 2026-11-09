; Komposit for Windows: the installer (Inno Setup 6).
;
;   iscc /DAppVersion=0.1.0 /DStage=<stage folder> /DOutDir=<dist folder> komposit.iss
;
; A per-user install (no administrator prompt) into %LOCALAPPDATA%\Programs\Komposit,
; a Start-menu entry, optional start at sign-in, and an uninstaller in
; Settings > Apps. Settings and chats in %APPDATA%\Komposit are kept on
; uninstall (like the Mac, where they stay in Application Support).
; packaging/windows/build.mjs fills the stage folder and runs this.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Stage
  #define Stage "..\..\dist\windows\stage"
#endif
#ifndef OutDir
  #define OutDir "..\..\dist"
#endif

[Setup]
AppId={{6B0F3B7E-2C1D-4F4B-9E58-6D2B6A7C1F10}
AppName=Komposit
AppVersion={#AppVersion}
AppVerName=Komposit {#AppVersion} preview
AppPublisher=Komposit
AppPublisherURL=https://komposit.werq.dev
AppSupportURL=https://komposit.werq.dev
AppComments=A design agent for Illustrator, Photoshop and After Effects.
DefaultDirName={autopf}\Komposit
DefaultGroupName=Komposit
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutDir}
OutputBaseFilename=Komposit-Setup-{#AppVersion}
SetupIconFile={#Stage}\komposit.ico
UninstallDisplayIcon={app}\Komposit.exe
UninstallDisplayName=Komposit
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Close a running Komposit before replacing its files.
CloseApplications=force
RestartApplications=no

[Tasks]
Name: "startup"; Description: "Start Komposit when I sign in"; GroupDescription: "Options:"
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Options:"; Flags: unchecked

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Komposit"; Filename: "{app}\Komposit.exe"; IconFilename: "{app}\komposit.ico"; Comment: "Open Komposit"
Name: "{autodesktop}\Komposit"; Filename: "{app}\Komposit.exe"; IconFilename: "{app}\komposit.ico"; Tasks: desktopicon

[Registry]
; The same value the tray menu's "Open at Login" sets and clears.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Komposit"; ValueData: """{app}\Komposit.exe"" --background"; Flags: uninsdeletevalue; Tasks: startup

[Run]
Filename: "{app}\Komposit.exe"; Description: "Open Komposit"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Stop the tray app and the server under it (its job object ends the rest).
Filename: "{sys}\taskkill.exe"; Parameters: "/IM Komposit.exe /T /F"; Flags: runhidden; RunOnceId: "StopKomposit"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\node"
