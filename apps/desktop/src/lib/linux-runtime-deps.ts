/** Runtime packages for the Linux builds LocalPrism actually ships. */
export const LINUX_RUNTIME_DEPS = {
  debianPackages: [
    "libwebkit2gtk-4.1-0",
    "libgtk-3-0",
    "libayatana-appindicator3-1",
  ],
  debianGtkAlternative: "libgtk-3-0t64",
  debianInstall:
    "sudo apt install libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1",
  debianPackageInstall: "sudo apt install ./LocalPrism-Linux.deb",
  rpmPackages: ["webkit2gtk4.1", "gtk3"],
  rpmInstall: "sudo dnf install webkit2gtk4.1 gtk3",
  summary:
    "Install the .deb with apt so WebKitGTK 4.1 is pulled in. dpkg -i skips those libraries and the app exits before a window opens. In-app updates install the AppImage; deb and rpm updates come from Releases.",
} as const;

export function isLinuxDesktop(userAgent: string): boolean {
  return /Linux/i.test(userAgent) && !/Android/i.test(userAgent);
}
