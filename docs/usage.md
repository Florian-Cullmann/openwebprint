# Using openwebprint

[Back to the README](../README.md) · [Installation](installation.md) · [Self-hosting](self-hosting.md)

This guide describes the current `main` branch. Packaged releases may have fewer features; check the [beta.2 release notes](releases/v0.1.0-beta.2.md).

## Setup and language

Choose **Try demo** to explore simulated devices, or **Start setup** to connect your own hardware. Demo printing never reaches CUPS, and demo scans are labeled sample documents. Hardware mode never falls back to simulation.

Use the compact **EN / DE** button during setup, sign-in, or normal use to switch between English and German. The preference is saved in this browser; dates, numbers, and plural forms follow the selected language. See the [translation convention](../CONTRIBUTING.md#translations) for detection and fallback rules.

Setup searches for compatible printers and scanners, lets you choose which to connect (or add one manually), then asks for a writable scan storage folder on the server. You can continue without devices and add them later under **Devices**. Setup progress survives restarts.

To leave the demo, click **Remove demo data** in the banner. This deletes demo devices, jobs, and scan files, waits for running demo operations to finish, and opens real device discovery. Accounts and any existing hardware records are preserved. Existing configured installations keep their current mode when upgrading.

## Settings profiles

Print and scan dialogs offer **Settings profiles** for each device: name and save the current settings, select and apply a saved profile, update it (including its name), or delete it. Profiles are stored in SQLite across restarts and shared instance-wide by all users, including when login is disabled. They contain settings only, never uploaded documents or job identifiers. Print profiles save copies, color mode, sides, and paper size; page ranges and odd/even filters remain with the current document. Scan profiles save resolution, color mode, paper source, and duplex; single-page versus batch scanning remains an explicit action.

Saving, updating, and applying a profile query the device capabilities again, including the selected scan source. Unsupported or incomplete capabilities produce an error without substituting settings or changing the saved profile. If capabilities change after applying, unavailable settings remain visible and submission is blocked until corrected. Deleting a device deletes its profiles; adding it again starts without profiles. Removing demo data also removes demo profiles. Each device can have up to 50 profiles.

## Printing

Review a PDF or image before printing, browse its pages, zoom in to inspect small text, and set printer, color, sides, paper size, and copies. Drag with a mouse, swipe, scroll or focus the preview and use arrow keys to move around an enlarged page. **Fit page** restores the full page; changing pages or documents resets zoom and position. Preview zoom does not change print settings. Open the retained document again from Jobs after submission. See the zoomed preview on [desktop](images/preview-zoom.png) and [mobile](images/preview-zoom-mobile.png).

Choose **Print** in a saved scan or retained document preview to select a printer and review its current options without downloading and uploading the PDF. Each confirmed submission creates an independent job; changing or deleting the source does not change that job. Files follow the instance retention policy (seven days by default). If the original print outcome is unknown, check Jobs and the printer first: reprinting may produce duplicate output. See [printing a saved scan](images/saved-document-print.png).

Print all pages by default, or choose **Custom range** (for example, `1-3, 7`) and optionally filter to odd or even original page numbers. The filter applies within the range; overlapping entries print once in document order. The summary lists the pages per copy before submission. Both the browser and server reject invalid, out-of-bounds, or empty selections. The preview shows the full source document; the retained print PDF contains only the submitted pages. Duplex pairs consecutive selected pages without gaps for skipped pages, leaving a blank back for an unpaired final page. Odd/even filtering is not a manual duplex workflow. See [page selection](images/print-page-selection.png).

Single-sided, long-edge duplex, and short-edge duplex are offered only when the printer advertises support. A4, A5, and Letter are available only when supported by its CUPS queue. If sides or paper capabilities cannot be retrieved, printing is blocked instead of guessing. See [printer setup](hardware.md#printers).

## Scanning and editing

Review, crop, rotate, reorder, or remove scanned pages, download or print the PDF, or scan another page. A scan must keep at least one page; delete the scan from Scans to remove the entire document. The sample document is clearly marked as simulated; hardware mode uses the actual scanner output. See the multi-page editor with bounded thumbnails on [desktop](images/scan-thumbnails.png) and [mobile](images/scan-thumbnails-mobile.png).

Collect up to 100 scanned pages in one PDF. **Scan another page** appends one page; select a scanner-advertised ADF or duplex ADF source and use **Scan multiple pages** to read a feeder batch. Rotate each page clockwise in 90° steps and reorder by dragging or with the arrow buttons; changes are saved automatically. Reopen the scan to add or edit pages. New scan PDFs preserve physical page dimensions, including crops and pages appended at different resolutions; see [legacy scan sizing](hardware.md#scanners). Failed follow-up scans keep the previously saved document.

Closing the scan dialog leaves acquisition running; choose **Cancel scan** to stop it. Cancellation discards the current operation's new pages and keeps previously saved pages. A single-page operation can run for up to 120 seconds, a feeder batch for 10 minutes. After a failed batch, **Scan incomplete** can offer fully acquired pages to keep or discard. See [scanner options, cropping, recovery, and legacy page sizing](hardware.md#scanners) for details and physical-hardware verification limits. OCR is not implemented.

## Export selected scans

In **Scans**, use the small checkbox at the top-left of a preview to select saved PDFs. The export toolbar appears only once at least one scan is selected; choose **Download ZIP** to hand over those documents together. Clearing the last selection hides the toolbar again. Selection stays across history pages and Grid/List views; review or remove off-page selections before downloading. The limit is 50 PDFs totaling 100 MiB. Changed, expired or missing scans stop the export with an explanation rather than being silently skipped. Clear the selection to start over; leaving Scans or changing mode clears it too. Downloads can be canceled and expire after two minutes (or earlier when a source expires), so use smaller batches on slow connections. Source documents and their retention dates stay unchanged. This exports PDFs as separate ZIP entries; it is not an instance backup.

## History and previews

Jobs distinguish queued, processing, completed, canceled, failed, and unknown outcomes. Cancel active prints or scans; delete completed records and their files when no longer needed. Jobs submitted outside openwebprint are not imported. Removing a device leaves its CUPS queue intact.

- Scan gallery and editor thumbnails fit within **512 × 512 pixels**, without enlarging small pages. Editor images load on demand; cropping still uses original pixels and PDF exports retain their resolution and physical size. Thumbnails are cached on disk in private `DATA_DIR/files/<job-id>.thumbnails` folders, one current crop/rotation variant per requested page. Unchanged pages keep their cached images across reordering and appended scans; obsolete variants are removed after saved edits and at startup. Deletion, expiry, and demo removal also remove these caches. Image responses use `Cache-Control: no-store`, like other private API responses.

- Jobs show **50 records per page**; Scans show **30 scans per page** in either grid or list view. The browser remembers your scan view choice. **Search scans** finds titles across the complete scan history as you type (after a short pause), ignoring case and matching literal text, including punctuation. It searches metadata, not document contents/OCR. Changing or clearing the query returns to the first page; Previous/Next keeps the query. See the search on [desktop](images/scan-search.png) and [mobile](images/scan-search-mobile.png). The pagination shows your current range, the total matching records, and the current/total pages. Use Previous/Next to reach older records. Job status filters apply to the entire history; Scans has its own listing. New jobs appear on the first page without shifting the cursor for older pages. Overview shows recent activity. File expiry removes documents, not history records. History is local SQLite data; it is not an analytics service.

Files expire under the [instance retention policy](self-hosting.md#storage-backups-and-access-recovery), seven days by default. Expiry removes documents, not their history records. Download important documents before they expire.

## Job notifications

In **Settings → General → Job notifications**, choose **Enable notifications** to request browser permission. HTTPS (or localhost) and a supporting browser are required. Blocked, unavailable and unsupported notifications fall back to in-app job updates. Some mobile browsers cannot display these system notifications; the app reports display failures. No external push service is used. See the [notification settings](images/job-notifications.png).

Keep the application open: each tab follows only print and scan operations started there, polling those jobs every five seconds even in a background tab when notifications are enabled and permission is granted. Browsers may delay background timers or suspend tabs. Reconnection reconciles tracked jobs once, without importing historical jobs. Demo messages are explicitly marked. Clicking a notification opens its job; messages omit document titles, device names and error details. Provider-reported print completion does not confirm physical output; unknown outcomes are reported as unconfirmed. Each operation produces at most one outcome notification; consult Jobs for subsequent status changes.

Preferences apply to this browser and current user/mode. Tabs own separate jobs, preventing duplicate notifications without a tab leader or takeover. Reloading/closing the originating tab ends tracking. Signing out, removing demo data or changing the preference clears pending updates and closes existing system notifications (also in other open tabs). Re-enabling starts fresh and never replays old outcomes. In-app updates retain the latest five outcomes until dismissed or tracking is reset. The browser’s notification permission remains under its site settings.

## Users and passwords

Create users under **Settings → Users** (`/settings/users`). Adding the first user enables login immediately, including for the creator. All users can manage the instance and access its devices/documents. Removing the last user disables login again. Signed-in users can change their own password under **Settings → Users** by entering their current password. The current browser receives a new session and stays signed in; all other sessions for that account are revoked. Passwords must not be empty. There are no length or character-composition requirements. Existing accounts are preserved when upgrading; legacy sessions expire once during the database migration.

## Pages and settings

Pages have shareable URLs and support refresh and browser back/forward navigation: `/overview`, `/devices`, `/jobs`, `/scans`, `/setup` (during onboarding), and `/login` (when login is enabled). `/` redirects to `/overview`.

Settings use a horizontal menu with their own URLs:

| Category   | URL                    | Contents                                                                                 |
| ---------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| General    | `/settings/general`    | Operating mode, scan storage, document retention, job notifications, project information |
| Users      | `/settings/users`      | Manage users and passwords; enable or disable login by user count                        |
| Appearance | `/settings/appearance` | Light, dark, or system theme                                                             |
| Hardware   | `/settings/hardware`   | Prerequisites, diagnostics, compatibility, and driver guidance                           |

`/settings` redirects to General. Fastify serves the React entry point for page URLs; `/api/*` remains a separate API namespace.
