; Triple Re Mobile Eraser — Windows installer (Inno Setup 6).
; iscc /DAppVersion=1.0.0 /DSourceDir=..\dist\app /DOutputDir=..\dist installer.iss

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\app"
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif
#define AppName "Triple Re Mobile Eraser"
#define AppExe "Triple Re Mobile Eraser.exe"

[Setup]
AppId={{6E2F4C1A-3B7D-4E8A-9C21-7A5D0B9E4F12}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Triple Re
AppPublisherURL=https://triplere.net
VersionInfoVersion={#AppVersion}
VersionInfoCompany=Triple Re
VersionInfoDescription={#AppName} Setup
VersionInfoProductName={#AppName}
DefaultDirName={autopf}\Triple Re\Mobile Eraser
DefaultGroupName=Triple Re
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=TripleRe-Mobile-Eraser-Setup-{#AppVersion}
SetupIconFile={#SourceDir}\assets\triplere.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
CloseApplications=force
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Icons:"

[Dirs]
; Reports, licence file and iOS downloads: every technician account on this PC can write here.
Name: "{commonappdata}\Triple Re\Mobile Eraser"; Permissions: users-modify

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Reports folder"; Filename: "{commonappdata}\Triple Re\Mobile Eraser\reports"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "Open {#AppName}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM ""{#AppExe}"" /T"; Flags: runhidden; RunOnceId: "StopApp"

[Code]
// iPhone / iPad need Apple's USB driver, which comes with the free "Apple Devices" app (or iTunes).
function AppleDriverInstalled(): Boolean;
begin
  Result := RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\Apple Mobile Device Service')
    or RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\AppleMobileDeviceService')
    or RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\USBAAPL64');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if (CurStep = ssPostInstall) and (not WizardSilent()) and (not AppleDriverInstalled()) then
  begin
    if MsgBox('To erase iPhones and iPads, this PC also needs Apple''s free "Apple Devices" app (it installs the USB driver).' + #13#10 + #13#10 +
              'Samsung and other Android phones work without it.' + #13#10 + #13#10 +
              'Open Microsoft Store to install Apple Devices now?', mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K', '', '', SW_SHOWNORMAL, ewNoWait, Code);
  end;
end;
