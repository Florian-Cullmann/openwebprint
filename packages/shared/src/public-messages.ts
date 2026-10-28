// Public, safe messages. Codes are part of the API contract: keep them stable.
export const publicMessages = {
  requests_from_this_origin_are_not_allowed_check_app:
    'Requests from this origin are not allowed. Check APP_ORIGIN.',
  please_sign_in: 'Please sign in.',
  invalid_history_cursor_refresh_the_list_and_try_again:
    'Invalid history cursor. Refresh the list and try again.',
  unknown_upload_field: 'Unknown upload field.',
  the_file_exceeds_25_mb: 'The file exceeds 25 MB.',
  invalid_print_parameters: 'Invalid print parameters.',
  choose_a_file: 'Choose a file.',
  invalid_print_options: 'Invalid print options.',
  only_a_document_upload_is_accepted: 'Only a document upload is accepted.',
  page_unavailable: 'Page unavailable.',
  no_document_available_files_follow_the_instance_retention_policy:
    'No document available. Files follow the instance retention policy; older print jobs may have no retained preview.',
  file_unavailable: 'File unavailable.',
  sign_in_to_manage_users: 'Sign in to manage users.',
  this_username_is_already_in_use: 'This username is already in use.',
  user_not_found: 'User not found.',
  current_password_is_incorrect: 'Current password is incorrect.',
  your_session_changed_please_sign_in_again: 'Your session changed. Please sign in again.',
  incorrect_username_or_password: 'Incorrect username or password.',
  the_file_must_be_between_1_byte_and_25: 'The file must be between 1 byte and 25 MB.',
  the_file_type_does_not_match_its_contents: 'The file type does not match its contents.',
  the_pdf_is_damaged_encrypted_has_unsupported_form_fields:
    'The PDF is damaged, encrypted, has unsupported form fields or exceeds 500 pages.',
  only_valid_pdf_png_and_jpeg_files_are_allowed: 'Only valid PDF, PNG and JPEG files are allowed.',
  the_image_is_damaged_or_exceeds_40_megapixels: 'The image is damaged or exceeds 40 megapixels.',
  the_scanned_pages_could_not_be_converted_to_pdf:
    'The scanned pages could not be converted to PDF. Check scan storage and try again.',
  the_crop_must_be_a_non_empty_rectangle_within:
    'The crop must be a non-empty rectangle within the original page.',
  a_scanned_page_is_incomplete_damaged_or_exceeds_80:
    'A scanned page is incomplete, damaged or exceeds 80 megapixels.',
  device_not_found: 'Device not found.',
  value1_is_not_installed_check_the_hardware_configuration:
    '{value1} is not installed. Check the hardware configuration.',
  value1_operation_timed_out_check_the_device_connection:
    '{value1}: operation timed out. Check the device connection.',
  cups_did_not_return_a_valid_ipp_response: 'CUPS did not return a valid IPP response.',
  invalid_cups_queue_name: 'Invalid CUPS queue name.',
  enter_a_valid_ipp_or_ipps_address: 'Enter a valid ipp:// or ipps:// address.',
  only_ipp_ipps_addresses_without_credentials_query_strings_or:
    'Only IPP/IPPS addresses without credentials, query strings or fragments are allowed.',
  enter_a_valid_sane_device_id_e_g_airscan:
    'Enter a valid SANE device ID, e.g. airscan:e0:Brother.',
  invalid_airscan_discovery_address: 'Invalid AirScan discovery address.',
  invalid_airscan_url: 'Invalid AirScan URL.',
  cups_did_not_return_a_job_id_check_the:
    'CUPS did not return a job ID. Check the queue before printing again.',
  invalid_job_id: 'Invalid job ID.',
  the_scanner_does_not_support_the_selected_source:
    'The scanner does not support the selected source.',
  choose_a_document_feeder_source_for_batch_scanning:
    'Choose a document feeder source for batch scanning.',
  scanner_paper_sources_are_unavailable_retry_discovery_or_use:
    'Scanner paper sources are unavailable. Retry discovery or use the device default.',
  batch_scanning_requires_a_document_feeder: 'Batch scanning requires a document feeder.',
  the_scanner_does_not_support_the_duplex_option: 'The scanner does not support the duplex option.',
  could_not_remove_a_document_file_check_file_permissions:
    'Could not remove a document file. Check file permissions and try again.',
  this_document_has_expired_or_was_deleted_upload_it:
    'This document has expired or was deleted. Upload it again or create a new scan.',
  only_demo_devices_are_allowed_in_demo_mode_remove:
    'Only demo:// devices are allowed in demo mode. Remove demo data and start setup to use real devices.',
  this_device_still_has_active_or_unconfirmed_jobs:
    'This device still has active or unconfirmed jobs.',
  this_scan_has_changed_close_this_dialog_and_reopen:
    'This scan has changed. Close this dialog and reopen it to review the latest document.',
  this_document_is_no_longer_available_upload_it_again:
    'This document is no longer available. Upload it again or create a new scan.',
  cannot_read_the_saved_document_check_document_storage_permissions:
    'Cannot read the saved document. Check document storage permissions.',
  the_saved_document_was_deleted_or_is_unavailable_in:
    'The saved document was deleted or is unavailable in this mode. Upload it again or create a new scan.',
  wait_for_the_scan_to_finish_before_printing_it: 'Wait for the scan to finish before printing it.',
  this_printer_is_no_longer_available_select_another_printer:
    'This printer is no longer available. Select another printer or add one on the Devices page.',
  the_selected_device_is_not_a_printer: 'The selected device is not a printer.',
  this_printer_is_offline_check_its_connection_or_select:
    'This printer is offline. Check its connection or select another printer.',
  unable_to_retrieve_print_options_check_the_cups_connection:
    'Unable to retrieve print options. Check the CUPS connection.',
  unable_to_retrieve_supported_print_sides_check_the_cups:
    'Unable to retrieve supported print sides. Check the CUPS connection.',
  unable_to_retrieve_supported_print_color_modes_check_the:
    'Unable to retrieve supported print color modes. Check the CUPS connection.',
  this_device_does_not_support_the_selected_print_options:
    'This device does not support the selected print options.',
  the_selected_device_is_not_a_scanner: 'The selected device is not a scanner.',
  this_scanner_is_already_in_use: 'This scanner is already in use.',
  keep_or_discard_recoverable_pages_before_scanning_again:
    'Keep or discard recoverable pages before scanning again.',
  use_the_original_scanner_to_add_pages: 'Use the original scanner to add pages.',
  a_scan_can_contain_at_most_value1_pages: 'A scan can contain at most {value1} pages.',
  wait_for_a_completed_scan_with_available_pages: 'Wait for a completed scan with available pages.',
  no_pages_were_scanned_load_paper_and_try_again:
    'No pages were scanned. Load paper and try again.',
  a_scan_can_contain_at_most_value1_pages_existing:
    'A scan can contain at most {value1} pages. Existing pages were kept.',
  wait_for_the_current_scan_operation_to_finish: 'Wait for the current scan operation to finish.',
  this_recovery_changed_reopen_the_scan_before_trying_again:
    'This recovery changed. Reopen the scan before trying again.',
  these_recoverable_pages_have_expired_start_a_new_scan:
    'These recoverable pages have expired. Start a new scan.',
  this_scan_changed_reopen_it_before_editing: 'This scan changed. Reopen it before editing.',
  keep_at_least_one_scanned_page_and_include_each:
    'Keep at least one scanned page and include each page at most once.',
  job_not_found: 'Job not found.',
  this_scan_operation_cannot_be_canceled: 'This scan operation cannot be canceled.',
  this_job_cannot_be_canceled_check_unconfirmed_submissions_directly:
    'This job cannot be canceled. Check unconfirmed submissions directly in CUPS.',
  active_jobs_cannot_be_deleted: 'Active jobs cannot be deleted.',
  another_setup_operation_is_in_progress: 'Another setup operation is in progress.',
  setup_is_changing_please_try_again: 'Setup is changing. Please try again.',
  complete_setup_before_printing_or_scanning: 'Complete setup before printing or scanning.',
  demo_mode_is_only_available_before_hardware_setup:
    'Demo mode is only available before hardware setup.',
  setup_has_already_started: 'Setup has already started.',
  demo_mode_is_not_active: 'Demo mode is not active.',
  choose_demo_mode_or_start_setup_first: 'Choose demo mode or start setup first.',
  device_selection_is_not_the_current_setup_step: 'Device selection is not the current setup step.',
  enter_an_absolute_server_folder_path: 'Enter an absolute server folder path.',
  unable_to_write_to_this_folder_check_the_server:
    'Unable to write to this folder. Check the server path, permissions and Docker mounts.',
  scan_storage_is_not_the_current_setup_step: 'Scan storage is not the current setup step.',
  this_shorter_policy_makes_existing_documents_eligible_for_deletion:
    'This shorter policy makes existing documents eligible for deletion. Review the impact and confirm the change.',
  the_document_has_no_printable_pages: 'The document has no printable pages.',
  choose_all_odd_or_even_pages: 'Choose all, odd or even pages.',
  enter_page_numbers_or_ranges_such_as_1_3:
    'Enter page numbers or ranges, such as 1-3, 7 (up to 2000 characters).',
  use_page_numbers_or_ranges_separated_by_commas_such:
    'Use page numbers or ranges separated by commas, such as 1-3, 7.',
  page_ranges_must_run_from_a_lower_page_number:
    'Page ranges must run from a lower page number to a higher one.',
  page_numbers_must_be_between_1_and_value1: 'Page numbers must be between 1 and {value1}.',
  this_selection_contains_no_pages_change_the_range_or:
    'This selection contains no pages. Change the range or page filter.',
  scan_export_busy: 'Two ZIP exports are already running. Wait for one to finish.',
  scan_export_interrupted:
    'ZIP export interrupted or expired. Refresh the selection and try again.',
  scan_export_selection_unavailable:
    'Selected scan {value1} was deleted or is unavailable in this mode. Remove it from the selection.',
  scan_export_selection_expired:
    'Selected scan {value1} has expired or has no saved PDF. Remove it from the selection.',
  scan_export_selection_changed:
    'Selected scan {value1} has changed. Remove it from the selection and select it again.',
  scan_export_selection_busy:
    'Selected scan {value1} is busy. Wait for it to finish and refresh the selection.',
  scan_export_pdf_unreadable:
    'Selected scan {value1} has a missing or unreadable PDF. Remove it from the selection.',
  scan_export_pdf_empty:
    'Selected scan {value1} has no readable PDF. Remove it from the selection.',
  scan_export_too_large: 'Selected PDFs exceed the 100 MiB ZIP export limit. Select fewer scans.',
  scan_export_size_exceeded: 'ZIP export exceeded its size limit. Select fewer scans.',
  scan_export_read_failed: 'A selected PDF could not be read. Refresh the selection and try again.',
  scan_export_pdf_missing:
    'A selected PDF is missing or unreadable. Refresh the selection and select the available scans again.',
  operation_failed: 'The operation failed. Check the server logs.',
  invalid_input: 'Please check your input.',
  upload_too_large: 'File too large. Maximum size: 25 MB.',
  invalid_request: 'Invalid request or too many requests. Please try again.',
  endpoint_not_found: 'Endpoint not found.',
  command_failed:
    '{value1} could not complete the operation. Check connectivity, permissions and device options.',
  cups_empty: 'No printers have been configured in CUPS.',
  feeder_empty: 'The document feeder is empty.',
  server_restarted:
    'The server restarted during this operation. Check the device before trying again.',
  print_submission_failed: 'Print submission failed.',
  scan_failed: 'Scan failed.',
  scan_canceled:
    'Scan canceled. New pages from this operation were discarded. Previously saved pages were kept.',
  scan_cleanup_failed:
    'The document was saved, but obsolete files could not be removed. Check scan storage permissions.',
  job_status_unavailable: 'Job status is currently unavailable.',
  cups_job_status_unavailable: 'CUPS job status is currently unavailable.',
  cups_aborted: 'CUPS aborted this job. Check the CUPS logs.',
  scan_resolution_unknown:
    'Scanner resolutions are unknown. Choose a fallback resolution (150, 300 or 600 dpi), or retry discovery.',
  scan_resolution_unsupported:
    'The scanner does not support the selected resolution for this paper source.',
  scan_color_unknown: 'Scanner color modes are unknown. Choose Color or Gray, or retry discovery.',
  scan_color_unsupported:
    'The scanner does not support the selected color mode for this paper source.',
  device_add_failed: 'Unable to add device.',
  recovered_page: 'Acquisition incomplete. Kept {value1} recovered page.',
  recovered_pages: 'Acquisition incomplete. Kept {value1} recovered pages.',
} as const;

export type PublicMessageCode = keyof typeof publicMessages;
export type MessageParams = Record<string, string | number>;
export interface PublicMessage {
  code: PublicMessageCode;
  params: MessageParams;
}
const commands = new Set(['lp', 'lpstat', 'lpinfo', 'lpadmin', 'cancel', 'scanimage']);
const entries = Object.entries(publicMessages).map(([code, text]) => {
  const names = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  const pattern = text
    .split(/\{\w+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('(.+?)');
  return { code: code as PublicMessageCode, text, names, pattern: new RegExp(`^${pattern}$`) };
});
function safeParam(value: unknown): value is string | number {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && (/^\d{1,15}$/.test(value) || commands.has(value)))
  );
}
export function publicMessage(message: string): { code: PublicMessageCode; params: MessageParams } {
  for (const entry of entries) {
    const match = entry.pattern.exec(message);
    if (!match) continue;
    const params: MessageParams = {};
    let valid = true;
    entry.names.forEach((name, index) => {
      const value = match[index + 1];
      if (!safeParam(value)) valid = false;
      else params[name] = /^\d+$/.test(value) ? Number(value) : value;
    });
    if (valid) return { code: entry.code, params };
  }
  return { code: 'operation_failed', params: {} };
}
export function publicMessageText(code: unknown, params: unknown = {}): string {
  if (typeof code !== 'string' || !Object.hasOwn(publicMessages, code))
    return publicMessages.operation_failed;
  const text = publicMessages[code as PublicMessageCode];
  const values =
    params !== null && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  let valid = true;
  const result = text.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (!safeParam(value)) {
      valid = false;
      return '';
    }
    return String(value);
  });
  return valid ? result : publicMessages.operation_failed;
}
export function publicErrorBody(message: string) {
  const { code, params } = publicMessage(message);
  return { error: publicMessageText(code, params), code, params };
}

// Persisted errors can combine acquisition, recovery, and cleanup notices. Expose
// each safe part with its own code, never the original provider diagnostics.
export function publicMessageParts(message: string): PublicMessage[] {
  const recovered = /^Acquisition incomplete\. Kept (\d+) recovered pages\. (.*)$/.exec(message);
  if (recovered) {
    const count = Number(recovered[1]);
    return [
      { code: count === 1 ? 'recovered_page' : 'recovered_pages', params: { value1: count } },
      ...publicMessageParts(recovered[2]),
    ];
  }
  const cleanup = publicMessages.scan_cleanup_failed;
  if (message.endsWith(` ${cleanup}`))
    return [
      ...publicMessageParts(message.slice(0, -cleanup.length - 1)),
      { code: 'scan_cleanup_failed', params: {} },
    ];
  return [publicMessage(message)];
}
