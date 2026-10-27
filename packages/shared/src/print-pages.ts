export interface PrintPageSelection {
  pageRanges?: string;
  pageParity?: 'all' | 'odd' | 'even';
}

// Numbers refer to the normalized source PDF, before filtering or duplex pairing.
export function resolvePrintPages(pageCount: number, selection: PrintPageSelection): number[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1)
    throw new Error('The document has no printable pages.');
  const { pageRanges, pageParity = 'all' } = selection;
  if (!['all', 'odd', 'even'].includes(pageParity))
    throw new Error('Choose all, odd or even pages.');
  const selected = new Set<number>();
  if (pageRanges === undefined) {
    for (let page = 1; page <= pageCount; page++) selected.add(page);
  } else {
    if (!pageRanges.trim() || pageRanges.length > 2000)
      throw new Error('Enter page numbers or ranges, such as 1-3, 7 (up to 2000 characters).');
    for (const part of pageRanges.split(',')) {
      const match = /^\s*([1-9]\d*)\s*(?:-\s*([1-9]\d*)\s*)?$/.exec(part);
      if (!match)
        throw new Error('Use page numbers or ranges separated by commas, such as 1-3, 7.');
      const start = Number(match[1]);
      const end = Number(match[2] ?? match[1]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end)
        throw new Error('Page ranges must run from a lower page number to a higher one.');
      // Check bounds before expanding ranges, including pages the parity filter would remove.
      if (start > pageCount || end > pageCount)
        throw new Error(`Page numbers must be between 1 and ${pageCount}.`);
      for (let page = start; page <= end; page++) selected.add(page);
    }
  }
  const pages = [...selected]
    .filter((page) => pageParity === 'all' || page % 2 === (pageParity === 'odd' ? 1 : 0))
    .sort((a, b) => a - b);
  if (!pages.length)
    throw new Error('This selection contains no pages. Change the range or page filter.');
  return pages;
}

export function formatPrintPages(pages: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i];
    while (i + 1 < pages.length && pages[i + 1] === pages[i] + 1) i++;
    ranges.push(start === pages[i] ? String(start) : `${start}-${pages[i]}`);
  }
  return ranges.join(', ');
}
