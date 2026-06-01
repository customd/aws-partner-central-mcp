import { CATALOG_AWS, PARTNER_CENTRAL_CONSOLE_OPPORTUNITY_BASE } from "../constants.js";

/** A clickable link from an opportunity ID to its AWS-console page. */
export interface OpportunityLink {
  id: string;
  url: string;
}

/**
 * Bare Partner Central opportunity IDs: `O` followed by 6+ digits, at word
 * boundaries (so mid-identifier `O`s and short numbers are not matched).
 */
const OPPORTUNITY_ID = /\bO\d{6,}\b/g;

/**
 * Protected runs we must NOT rewrite: inline code / fenced code (`` `…` ``)
 * and existing markdown links (`[text](url)`). Splitting with a capturing
 * group puts the delimiters at odd indices and plain text at even indices.
 */
const PROTECTED = /(`+[^`]*`+|\[[^\]]*\]\([^)]*\))/g;

function consoleUrl(id: string): string {
  return `${PARTNER_CENTRAL_CONSOLE_OPPORTUNITY_BASE}/${id}`;
}

/**
 * Turn bare opportunity IDs in agent prose into markdown links to the AWS
 * console, returning the rewritten text and the de-duplicated links found.
 *
 * Only the production "AWS" catalog is linked — Sandbox is test data that does
 * not resolve in the production console, and an unknown catalog fails safe to
 * no links. Existing links and code spans are left untouched. Pure/total:
 * never throws; non-matching input returns unchanged.
 */
export function linkifyOpportunities(
  text: string,
  catalog: string | undefined,
): { text: string; links: OpportunityLink[] } {
  if (!text || catalog !== CATALOG_AWS) {
    return { text: text ?? "", links: [] };
  }

  const links: OpportunityLink[] = [];
  const seen = new Set<string>();

  const rewritten = text
    .split(PROTECTED)
    .map((part, i) => {
      if (i % 2 === 1) return part; // protected (code span/fence or existing link)
      return part.replace(OPPORTUNITY_ID, (id) => {
        if (!seen.has(id)) {
          seen.add(id);
          links.push({ id, url: consoleUrl(id) });
        }
        return `[${id}](${consoleUrl(id)})`;
      });
    })
    .join("");

  return { text: rewritten, links };
}
