import React, { useState } from "react";

export type HelpTopic = "load-backups" | "homeup-restore" | "nova-restore" | "play-icons";
export type ShellVariant = "powershell" | "bash";

const HOME_UP_GALAXY_STORE_URL =
  "https://galaxystore.samsung.com/detail/com.samsung.android.app.homestar";
const GOOD_LOCK_GALAXY_STORE_URL =
  "https://galaxystore.samsung.com/detail/com.samsung.android.goodlock";

interface NavigatorWithUAData extends Navigator {
  userAgentData?: {
    platform?: string;
  };
}

/**
 * Autodetect the user's host shell using modern User-Agent Client Hints
 * (`navigator.userAgentData.platform`), falling back to `navigator.platform` / `userAgent`.
 */
export function detectPreferredShell(nav?: NavigatorWithUAData): ShellVariant {
  const n =
    nav ?? (typeof navigator !== "undefined" ? (navigator as NavigatorWithUAData) : undefined);
  if (!n) return "bash";

  const clientHintPlatform = n.userAgentData?.platform?.trim() ?? "";
  if (clientHintPlatform) {
    return /^win/i.test(clientHintPlatform) ? "powershell" : "bash";
  }

  const legacyPlatform = `${n.platform ?? ""} ${n.userAgent ?? ""}`;
  return /\bwin(?:32|64|dows)/i.test(legacyPlatform) ? "powershell" : "bash";
}

export interface ExportCompletedInfo {
  target: "samsung" | "nova";
  filename: string;
  stamp?: string;
  savedDevPath?: string;
}

interface HelpModalProps {
  topic?: HelpTopic;
  exportInfo?: ExportCompletedInfo;
  onClose: () => void;
}

const ShellCommandSwitcher: React.FC<{
  commands: Record<ShellVariant, string>;
}> = ({ commands }) => {
  const [shell, setShell] = useState<ShellVariant>(() => detectPreferredShell());
  const [copied, setCopied] = useState(false);

  const activeCode = commands[shell];

  const handleCopy = (): void => {
    void navigator.clipboard?.writeText(activeCode).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className="help-cmd-wrapper mb-2">
      <div className="help-cmd-toolbar">
        <label className="help-shell-picker mb-0">
          <i className="fas fa-terminal me-2" aria-hidden="true" />
          <select
            className="shell-variant-select"
            aria-label="Shell syntax"
            value={shell}
            onChange={(e) => {
              setShell(e.target.value as ShellVariant);
              setCopied(false);
            }}
          >
            <option value="powershell">PowerShell (Windows)</option>
            <option value="bash">Bash / zsh (macOS &amp; Linux)</option>
          </select>
        </label>
        <button
          type="button"
          className="btn btn-sm btn-outline-info help-copy-btn"
          onClick={handleCopy}
        >
          <i className={`fas ${copied ? "fa-check" : "fa-copy"} me-1`} aria-hidden="true" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="help-path-box help-cmd-box">
        <pre className="mb-0">{activeCode}</pre>
      </div>
    </div>
  );
};

const HomeUpInstallNote: React.FC = () => (
  <p className="mb-2">
    <strong>Need Home Up?</strong> Install{" "}
    <a
      href={HOME_UP_GALAXY_STORE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="help-ext-link"
    >
      Home Up
    </a>{" "}
    (or{" "}
    <a
      href={GOOD_LOCK_GALAXY_STORE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="help-ext-link"
    >
      Good Lock
    </a>
    ) from the Samsung Galaxy Store. Home Up does not add its own icon to the app drawer &mdash;
    open it via <strong>Good Lock → Home Up</strong> or{" "}
    <strong>Home screen settings → More customizations</strong> (One UI 7+).
  </p>
);

const ADB_PULL_COMMANDS: Record<ShellVariant, string> = {
  powershell: `$latest = (adb shell "ls -1 /sdcard/Android/data/com.samsung.android.app.homestar/files/.AutoBackup/*.exml | sort | tail -n 1").Trim()
adb pull $latest .`,
  bash: `latest=$(adb shell 'ls -1 /sdcard/Android/data/com.samsung.android.app.homestar/files/.AutoBackup/*.exml | sort | tail -n 1' | tr -d '\\r')
adb pull "$latest" .`,
};

function buildSamsungPushCommands(filename: string, stamp?: string): Record<ShellVariant, string> {
  const resolvedStamp = stamp ?? filename.replace(/^homeup-backup-|\.zip$/g, "");
  return {
    powershell: `Expand-Archive -LiteralPath ".\\${filename}" -DestinationPath ".\\homeup-extracted" -Force
adb push ".\\homeup-extracted\\.AutoBackup\\${resolvedStamp}.exml" /sdcard/Android/data/com.samsung.android.app.homestar/files/.AutoBackup/${resolvedStamp}.exml
adb push ".\\homeup-extracted\\.AutoBackupPreview\\${resolvedStamp}.png" /sdcard/Android/data/com.samsung.android.app.homestar/files/.AutoBackupPreview/${resolvedStamp}.png`,
    bash: `unzip -o "${filename}" -d ./homeup-extracted
adb push "./homeup-extracted/.AutoBackup/${resolvedStamp}.exml" /sdcard/Android/data/com.samsung.android.app.homestar/files/.AutoBackup/${resolvedStamp}.exml
adb push "./homeup-extracted/.AutoBackupPreview/${resolvedStamp}.png" /sdcard/Android/data/com.samsung.android.app.homestar/files/.AutoBackupPreview/${resolvedStamp}.png`,
  };
}

function buildNovaPushCommands(filename: string): Record<ShellVariant, string> {
  return {
    powershell: `adb push ".\\${filename}" "/sdcard/Download/${filename}"`,
    bash: `adb push "./${filename}" "/sdcard/Download/${filename}"`,
  };
}

const HELP_CONTENT: Record<HelpTopic, { title: string; body: React.ReactNode }> = {
  "load-backups": {
    title: "Where to Find Your Launcher Backup Files",
    body: (
      <>
        <h6 className="fw-bold text-info">Nova Launcher (.novabackup)</h6>
        <ol className="ps-3 mb-3">
          <li>
            Open <strong>Nova Settings → Backup &amp; restore → Backup</strong>.
          </li>
          <li>Save to device storage or share directly to Google Drive / your computer.</li>
        </ol>

        <h6 className="fw-bold text-info">Samsung Home Up (.exml)</h6>
        <HomeUpInstallNote />
        <p className="mb-2">
          On your phone, open <strong>Home Up → Home screen → Backup and Restore</strong> and tap{" "}
          <strong>Immediate</strong> to snapshot your current layout. Because Android restricts{" "}
          <code>Android/data/</code> from on-phone apps, copy the <code>.exml</code> file from a
          computer using either <strong>USB File Transfer</strong> or <strong>ADB</strong>:
        </p>

        <div className="mb-2">
          <strong>Option 1 — USB File Transfer (No ADB required):</strong>
          <ol className="ps-3 mt-1 mb-2">
            <li>
              Plug your phone into your PC and select{" "}
              <strong>Transferring files / Android Auto</strong>.
            </li>
            <li>
              Enable <strong>Show hidden items</strong> in your PC&rsquo;s file browser (both backup
              folders start with a dot <code>.</code>) and navigate to:
              <div className="help-path-box mt-1 mb-1">
                Internal storage/Android/data/com.samsung.android.app.homestar/files/.AutoBackup/
              </div>
            </li>
            <li>
              Copy the newest <code>&lt;timestamp&gt;.exml</code> file (highest number / last when
              sorted alphabetically) to your PC.
            </li>
          </ol>
        </div>

        <div>
          <strong>Option 2 — Pull Latest Backup via ADB:</strong>
          <p className="mb-2 text-muted small">
            Home Up names backups with 13-digit epoch millisecond timestamps, so the last file in
            alphabetical order is always the newest:
          </p>
          <ShellCommandSwitcher commands={ADB_PULL_COMMANDS} />
        </div>
      </>
    ),
  },
  "homeup-restore": {
    title: "How to Restore a Samsung Home Up Bundle (.zip)",
    body: (
      <>
        <HomeUpInstallNote />
        <p className="mb-2">
          Each exported <strong>Home Up Bundle (.zip)</strong> contains two sibling folders with
          matching timestamps (Home Up requires the <code>.png</code> preview card to display the
          backup in its Restore list):
        </p>
        <div className="help-path-box mb-3">
          Android/data/com.samsung.android.app.homestar/files/
          <br />
          ├── .AutoBackup/&lt;timestamp&gt;.exml &nbsp;&nbsp;&nbsp;&nbsp;(layout file)
          <br />
          └── .AutoBackupPreview/&lt;timestamp&gt;.png &nbsp;(required restore preview)
        </div>

        <h6 className="fw-bold text-info">Option 1 — USB File Transfer</h6>
        <ol className="ps-3 mb-3">
          <li>Extract the downloaded ZIP on your computer (enable Show hidden items).</li>
          <li>
            Connect your phone in <strong>Transferring files</strong> mode and copy the{" "}
            <code>.exml</code> and <code>.png</code> files into their matching{" "}
            <code>.AutoBackup</code> and <code>.AutoBackupPreview</code> folders under{" "}
            <code>Internal storage/Android/data/com.samsung.android.app.homestar/files/</code>.
          </li>
          <li>
            Open <strong>Home Up → Home screen → Backup and Restore</strong> and tap your new entry
            to apply.
          </li>
        </ol>

        <h6 className="fw-bold text-info">Option 2 — Push via ADB</h6>
        <p className="mb-0">
          When you click <strong>Export Home Up Bundle (.zip)</strong>, a ready-to-copy{" "}
          <code>adb push</code> command dialog will pop up automatically with your exact exported
          filename filled in.
        </p>
      </>
    ),
  },
  "nova-restore": {
    title: "How to Restore a Nova Launcher Backup",
    body: (
      <ol className="ps-3 mb-0">
        <li>
          Copy the exported <code>.novabackup</code> file onto your Android phone (via USB, Google
          Drive, or <code>adb push</code>).
        </li>
        <li>
          Open <strong>Nova Settings → Backup &amp; restore → Restore or manage backups</strong> and
          select the <code>.novabackup</code> file (or tap it directly in your file manager).
        </li>
        <li>
          If any widgets came from a different device or launcher, tap each widget placeholder once
          on your home screen to grant Android widget binding permission.
        </li>
      </ol>
    ),
  },
  "play-icons": {
    title: "Resolving Unknown Apps Online",
    body: (
      <>
        <p className="mb-3">
          Samsung Home Up backups only store internal Android app IDs (such as{" "}
          <code>com.spotify.music</code>) without app names or icons. Core system apps and any
          matching apps from a loaded Nova Reference Backup are filled in locally first.
        </p>

        <h6 className="fw-bold text-info">What is shared when enabled</h6>
        <p className="mb-0">
          This option is <strong>off by default</strong>. When turned on, app IDs for any remaining
          unknown apps in your backup (including sideloaded or private work apps, if present) are
          checked in order against <strong>Google Play</strong>,{" "}
          <strong>Samsung Galaxy Store</strong>, and <strong>F-Droid / IzzyOnDroid</strong> to look
          up their display name and icon. Your backup file, folder names, and home screen layout
          stay in your browser.
        </p>
      </>
    ),
  },
};

const HelpModal: React.FC<HelpModalProps> = ({ topic, exportInfo, onClose }) => {
  let title = "";
  let body: React.ReactNode = null;

  if (exportInfo) {
    if (exportInfo.target === "samsung") {
      const cmds = buildSamsungPushCommands(exportInfo.filename, exportInfo.stamp);
      title = `Exported ${exportInfo.filename}`;
      body = (
        <>
          {exportInfo.savedDevPath && (
            <div className="alert alert-success py-2 mb-3">
              Saved directly to <code>{exportInfo.savedDevPath}</code>
            </div>
          )}
          <p className="mb-2">
            Run this from the folder where <code>{exportInfo.filename}</code> was saved to extract
            and push both the layout and its preview card onto your phone:
          </p>
          <ShellCommandSwitcher commands={cmds} />

          <div className="mt-3 mb-2">
            <strong>Or via USB File Transfer:</strong> Extract <code>{exportInfo.filename}</code>{" "}
            (with hidden files visible) and copy <code>.AutoBackup</code> and{" "}
            <code>.AutoBackupPreview</code> into{" "}
            <code>Internal storage/Android/data/com.samsung.android.app.homestar/files/</code>.
          </div>
          <p className="mb-0 text-info">
            Then open <strong>Home Up → Home screen → Backup and Restore</strong> on your phone and
            tap the newest backup entry to apply!
          </p>
        </>
      );
    } else {
      const cmds = buildNovaPushCommands(exportInfo.filename);
      title = `Exported ${exportInfo.filename}`;
      body = (
        <>
          {exportInfo.savedDevPath && (
            <div className="alert alert-success py-2 mb-3">
              Saved directly to <code>{exportInfo.savedDevPath}</code>
            </div>
          )}
          <p className="mb-2">
            Push <code>{exportInfo.filename}</code> to your phone&rsquo;s Downloads folder via ADB
            (or copy via USB / Google Drive):
          </p>
          <ShellCommandSwitcher commands={cmds} />
          <p className="mt-2 mb-0">
            Then open{" "}
            <strong>Nova Settings → Backup &amp; restore → Restore or manage backups</strong> and
            select <code>{exportInfo.filename}</code>.
          </p>
        </>
      );
    }
  } else if (topic) {
    title = HELP_CONTENT[topic].title;
    body = HELP_CONTENT[topic].body;
  }

  return (
    <div className="folder-modal-backdrop" onClick={onClose}>
      <div
        className="help-modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="folder-modal-header mb-2">
          <h5 className="mb-0">{title}</h5>
          <button
            type="button"
            className="btn btn-sm btn-outline-light ms-2"
            onClick={onClose}
            aria-label="Close help"
          >
            <i className="fas fa-times" aria-hidden="true" />
          </button>
        </div>
        <div className="help-modal-body">{body}</div>
      </div>
    </div>
  );
};

export default HelpModal;
