# Article Learning Assistant

## P0 ordinary-text trial scope

This candidate is for a first controlled ordinary-text learning trial. Its registered fixtures are the correlation, confounding, and randomized-comparison article A and the file-sync, snapshot, and migration article B. Users may still import arbitrary full articles; these two fixtures define the present trial rather than a permanent product restriction.

Passing this trial would show that the candidate can preserve and evaluate the intended ordinary-text workflow under the tested controls. It would not certify every programming or mathematical question, prove that a person learned the material, or establish cross-session durability or long-term reliability. Those claims require later authorized trials and real-user evidence.

## Known limitation

Question comparison currently removes whitespace next to punctuation. It can therefore merge some semantically meaningful operator sequences, including `a - --b` and `a-- - b`.

The controlled parser and saved-record example handles this conservatively: it withholds whole-article mastery, the first learned time, and the mastery reward, while retaining the original question, response, assessment, turn, and verified knowledge. This limitation was not observed in the registered materials, the nine learning-model outputs, or the saved states, and it has not been reproduced through a real browser/model/CAS learning chain. It is a non-blocking known limitation of this ordinary-text trial, not evidence of universal correctness for code or mathematical learning.

Any actual false mastery, lost record, cross-article contamination, false save, stale or late result acceptance, or fabricated reward remains a blocking defect and is not downgraded by this trial scope.
