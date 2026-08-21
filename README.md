# TweetXer GraphQL Safe

These notes summarize the changes made while developing **TweetXer
GraphQL Safe** through **v1.2.1**. 

## What this project does

TweetXer GraphQL Safe is a conservative, archive-driven userscript for
deleting X/Twitter posts through X's logged-in web session and internal
`DeleteTweet` GraphQL mutation.

The project was created to help work through IDs from an X data archive,
including older posts and repost-wrapper IDs that may still exist even
when X's normal web interface does not provide a usable
delete/undo-repost action.

**It is very slow to prevent rate-limiting, averaging just under 300 ids per hour.**

> **Important:** This uses an undocumented internal X GraphQL endpoint.
> X can change the endpoint, query ID, authentication behavior, headers,
> or rate limits at any time. Automated deletion can also carry account
> risk. Use at your own risk. 

## Screenshot in action

<img width="1219" height="450" alt="image" src="https://github.com/user-attachments/assets/0d8178e6-efa2-4a95-96cc-7721e337c4c3" />

<img width="1222" height="460" alt="image" src="https://github.com/user-attachments/assets/eb210912-3ab9-4e85-bace-d8477e888bb6" />

<img width="1216" height="451" alt="image" src="https://github.com/user-attachments/assets/18fbd22d-d8a2-41de-be6f-528ed8bdcc7b" />

## Screenshots from Twitter archive

Initial Twitter archive request

<img width="622" height="205" alt="image" src="https://github.com/user-attachments/assets/d616cd60-d8b8-4c99-a8b7-6209447a5abb" />

Follow up Twitter archive request

<img width="564" height="226" alt="image" src="https://github.com/user-attachments/assets/532b2d43-cb9e-4906-b070-fb6a7f97696f" />

## How to use with the extension (Chrome, Brave, Edge)

1.  Request and download your X data archive.
2.  Open X in the browser while logged into the account being cleaned.
3.  Download the extension folder and load unpacked extension into your browser
5.  Import `tweet-headers.js` (recommended) or `tweets.js`.
6.  Confirm that the expected archive total appears.
7.  If continuing an earlier run, enter the appropriate **Skip first
    IDs** value before starting.
8.  Press **Start / Resume**.
9.  Watch HTTP 200, 429, and Failed counters.
10. Allow automatic batch/rate-limit pauses to complete.
11. Export the JSON log periodically during long runs.
12. Use **Pause** before intentionally inspecting or changing the run.
13. Use **Reset progress** only when you intentionally want to discard
    the saved position and start a new run.

## How to use with dev tools

1.  Request and download your X data archive.
2.  Open X in the browser while logged into the account being cleaned.
3.  Open the browser console (F12 or cmd+option+i).
4.  Paste the [whole script](https://github.com/jsedmond/tweetXer-graphql-safe/blob/main/tweetxer_graphql_safe_v1_2_1.js) into the console and press enter.
5.  Import `tweet-headers.js` (recommended) or `tweets.js`.
6.  Confirm that the expected archive total appears.
7.  If continuing an earlier run, enter the appropriate **Skip first
    IDs** value before starting.
8.  Press **Start / Resume**.
9.  Watch HTTP 200, 429, and Failed counters.
10. Allow automatic batch/rate-limit pauses to complete.
11. Export the JSON log periodically during long runs.
12. Use **Pause** before intentionally inspecting or changing the run.
13. Use **Reset progress** only when you intentionally want to discard
    the saved position and start a new run.

## Archive input

The script supports either of these X archive files:

-   `tweet-headers.js`
-   `tweets.js`

Only **one** file is required for a run.

For a full archive-ID cleanup, `tweet-headers.js` is the recommended
input.

### Import validation

The importer now:

-   Uses separate selectors for `tweet-headers.js` and `tweets.js`.
-   Checks the selected filename.
-   Checks that the file contents match the expected archive structure.
-   Displays a prominent error when the wrong file is selected.
-   Rejects an archive that produces zero numeric tweet IDs.
-   Keeps **Start / Resume** disabled until a valid queue has been
    loaded.
-   Deduplicates tweet IDs before processing.

## GraphQL deletion

The script sends deletion requests through X's logged-in browser session
using the internal `DeleteTweet` GraphQL mutation.

A successful HTTP response is counted as:

`HTTP 200`

This means X accepted the GraphQL request. It does **not** independently
prove that the visible profile post count will decrease by exactly one.
Archive IDs may represent content that is already cleared, unavailable,
stale, or otherwise not reflected in the current profile count.

Testing has shown that the method can remove at least some older
repost-wrapper/"ghost repost" records for which the X UI displays the
repost but does not provide a usable **Undo repost** action.

## Conservative request pacing

Current defaults:

-   Random delay between requests: **2.5--6.5 seconds**
-   Batch size: **75 HTTP 200 responses**
-   Batch pause: **10 minutes**
-   Automatic rate-limit handling
-   Stop after **2 HTTP 429 responses**

The script intentionally prioritizes conservative pacing over maximum
deletion speed.

### Batch milestones

Batch pauses are now tied to absolute HTTP-200 milestones:

-   75
-   150
-   225
-   300
-   375
-   etc.

After the pause for a milestone completes, that milestone is recorded.
Pressing **Resume** will not intentionally trigger the same completed
batch pause again.

## Rate-limit handling

The script watches for HTTP `429` responses.

When available, it reads X's rate-limit reset information and waits
until the reset time plus an additional randomized buffer.

If a usable reset value is unavailable, the script uses a longer
fallback pause.

After **2 HTTP 429 responses**, the run stops instead of repeatedly
retrying requests.

The interface separately tracks:

-   Processed
-   HTTP 200
-   429
-   Failed

## Persistent progress

Starting with v1.2, progress is stored in browser `localStorage`.

Saved state includes:

-   Archive queue
-   Current queue position
-   Counters
-   Completed batch milestone
-   Result log
-   Rate-limit state

If the page reloads or the userscript is reinitialized, the script can
restore the saved queue position. It does **not** automatically resume
destructive actions after restoration; the user presses **Start /
Resume** to continue.

A **Reset progress** button clears the saved run state.

## Wall-clock batch pauses

Earlier versions used a decrementing JavaScript timer for batch waits.
Browser background-tab throttling or suspension could potentially make a
nominal 10-minute wait behave unpredictably.

Note: this successfully runs at 6 minutes without issue drastically decreasing the entire time to task.

v1.2 changed long waits to use an absolute wall-clock end time.

For example:

`pause end = current time + 10 minutes`

When execution resumes after browser throttling, the script compares the
current time with the intended end time rather than assuming every
one-second timer callback occurred.

## Pause/status visibility

The interface now distinguishes execution states such as:

-   `normal-delay`
-   `batch`
-   `user`
-   `rate-limit`
-   `rate-limit-stop`
-   `stopped`
-   `finished`

The UI also displays **Last activity**, making it easier to tell whether
the runner is actively progressing or has been idle.

## Skip first IDs

v1.2.1 added **Skip first IDs**.

This is useful when moving to a newer script version after part of an
archive has already been processed.

Example:

``` text
Archive total: 11,769
Skip first IDs: 150
Starting at: 151
Remaining: 11,619
```

Skipped IDs are **not** counted as newly processed requests or HTTP 200
responses. They are simply bypassed.

Once processing has begun, the skip value is locked. Use **Reset
progress** if a different starting position is required.

The interface displays:

-   Total archive IDs
-   Skip amount
-   Starting/current archive position
-   Remaining IDs
-   Newly processed requests

## Pause / Resume / Stop

### Pause

**Pause** requests a user pause. The current network request is allowed
to finish before the runner becomes idle.

### Start / Resume

**Start / Resume** continues from the current queue position.

### Stop

**Stop** ends the current run after the active request completes.

### Reset progress

**Reset progress** clears the persisted run state and allows a fresh
archive/skip configuration.

## Result logging

Every attempted GraphQL request is recorded in the in-memory audit log.

The log can include:

-   Timestamp
-   Tweet ID
-   Outcome
-   HTTP status
-   Response payload
-   Rate-limit remaining value
-   Rate-limit reset value

Use **Export log** to save the results as JSON.

This makes it possible to audit which archive IDs were attempted and
what X returned.

## Version history

### v1.0

Initial conservative GraphQL runner.

Added:

-   Archive-based `DeleteTweet` processing
-   Random 2.5--6.5 second request delay
-   75-item batches
-   10-minute batch pauses
-   HTTP 429 handling
-   Stop after repeated rate limits
-   Pause / Resume / Stop
-   JSON result export
-   HTTP response counters

### v1.1

Fixed archive importing.

Changes:

-   Fixed numeric tweet-ID validation that could cause a selected
    archive to load zero IDs.
-   Added separate `tweet-headers.js` and `tweets.js` selectors.
-   Added exact filename validation.
-   Added archive-content validation.
-   Added clearer wrong-file errors.
-   Disabled Start until a valid archive queue is loaded.
-   Added a clear **READY** message with the number of unique IDs
    loaded.

### v1.2

Focused on unattended-run reliability and resumability.

Changes:

-   Added persistent progress using `localStorage`.
-   Added restoration of queue position after page/script reload.
-   Changed batch logic to absolute 75-HTTP-200 milestones.
-   Prevented a completed milestone from intentionally causing the same
    batch pause again.
-   Changed long waits to wall-clock timing.
-   Added explicit pause-state reporting.
-   Added **Last activity** display.
-   Added **Reset progress**.
-   Preserved conservative request pacing and HTTP 429 safeguards.

### v1.2.1

Added migration/continuation support.

Changes:

-   Added **Skip first IDs**.
-   Added starting-position display.
-   Added remaining-ID display.
-   Skip value is applied before processing begins.
-   Skipped IDs do not inflate Processed or HTTP 200 counters.
-   Skip field locks once processing has started.

## Observed testing

During development, the script was tested against an X archive
containing **11,769 unique IDs**.

A known older repost-wrapper record that still appeared as a repost but
did not expose a usable **Undo repost** action in the X UI was submitted
through the GraphQL deletion path. Afterward, visiting that wrapper
status returned X's "page doesn't exist" state.

During a later v1.2.1 checkpoint:

``` text
Skip first IDs: 150
Newly processed: 225
HTTP 200: 225
HTTP 429: 0
Failed: 0
```

The visible profile count had also continued to decline during the run.

These observations are useful evidence that the method can affect
surviving archive records, but they should not be interpreted as a
guarantee that every HTTP 200 corresponds one-to-one with a visible
deleted post.

## Known limitations

-   Uses an undocumented X web GraphQL endpoint.
-   X may change the `DeleteTweet` query ID without notice.
-   X may change required request headers or authentication behavior.
-   HTTP 200 means the request was accepted; it is not independent
    deletion verification.
-   X's displayed profile post count may lag or update inconsistently.
-   Browser background throttling, system sleep, network interruptions,
    or X-side changes can interrupt a long run.
-   Automation may carry account restriction/suspension risk.
-   The script is designed for deliberate, conservative cleanup rather
    than maximum throughput.

## Credits / origin

This project was inspired by the archive-driven deletion approach used
by Luca Hammer's TweetXer project. TweetXer demonstrates using X
data-export tweet IDs with X's logged-in web session to delete old
posts, including posts that may no longer be readily visible on the
profile.

TweetXer GraphQL Safe focuses on a slower deletion loop, explicit
HTTP/result tracking, conservative rate-limit handling, persistent
progress, batch milestones, and resumable archive processing.
