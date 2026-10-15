/**
 * The analysis's distinct counts (2026-10-14): each identity once, the uploaded
 * IDs included, so the parts add up to the job's distinct identities. The
 * per-namespace numbers used to be summed per uploaded ID: the uploaded IDs were
 * left out and an identity shared by several uploaded IDs was counted once for
 * each, so a file of 6.8M hashedKocids showed fewer hashedKocids than emails.
 * Takes read-only readers (analysisReaders.js); imports nothing that opens the
 * app database.
 */
import { describeSourceIdentities, splitDistinctNamespaces } from './analysisCore.js';

/** Profiles NOT in the file, each once — one can share clusters with many uploaded
 *  IDs. Walks only the merged clusters (light: no sort of the job's rows). */
export async function countOutsideProfiles({ readers, sourceNs }) {
  const outside = new Set();
  for await (const chunk of readers.categoryChunks('merged_outside_list')) {
    for (const r of chunk) {
      for (const i of describeSourceIdentities({ sourceId: r.source_id, sourceNs, rows: readers.identitiesOf(r.source_id),
        isInList: readers.isInList })) {
        if (i.relation === 'other_profile' && !i.inList) outside.add(i.value);
      }
    }
  }
  return outside.size;
}

/** The rest, given the profiles NOT in the file: sorts every stored row of the job
 *  (minutes at 33M rows; temp files in the OS temp folder) — can throw, e.g. when
 *  there is no room for them. */
export function finishDistinctCounts({ readers, sourceNs, outsideProfiles }) {
  return { ...splitDistinctNamespaces(readers.distinctByNamespace(), sourceNs, outsideProfiles),
    mergedWithUploaded: readers.mergedWithUploaded() };
}

/**
 * @returns {Promise<{ uploaded: number, outsideProfiles: number,
 *   byNamespace: Record<string, number>, mergedWithUploaded: number }>}
 */
export async function computeDistinctCounts({ readers, sourceNs }) {
  return finishDistinctCounts({ readers, sourceNs, outsideProfiles: await countOutsideProfiles({ readers, sourceNs }) });
}
