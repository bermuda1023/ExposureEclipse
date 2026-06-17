# Error Handling — Exposure Eclipse

> Errors must be **friendly for users** and **technically complete for support**. Codes from
> `CONTRACTS.md §11`. Distinguish transport errors (HTTP envelope) from domain outcomes
> (returned in the body as warnings / status flags).

## Standard HTTP error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Friendly summary the user can act on.",
    "details": { "field": "treatyYear", "reason": "must be an integer" },
    "traceId": "uuid",
    "timestamp": "2026-06-17T12:00:00Z"
  }
}
```

`code` → HTTP status mapping is in `CONTRACTS.md §11`. `traceId` ties the user message to
server logs.

## Domain outcomes are NOT HTTP errors

These ride in successful responses as warnings / `null` metrics / job status — so the rest
of the view still renders:

- Missing IED denominator → market share `null` + `WARN_IED_DENOMINATOR_MISSING`.
- County data unavailable → state fallback + `WARN_COUNTY_DATA_UNAVAILABLE`.
- Failed ERT job → `GET status` returns `status: failed` + technical report (HTTP 200).
- Filters exclude everything → empty features + `WARN_FILTERS_RETURN_NO_ROWS`.

## User-facing examples

```
The ERT routine failed for Re_BER_27_Farmers_HU_EDM_01.
The app could not generate the required exposure tables. Review the details below or send
the error report to support.
```
```
Prior-year database was not found. Check the server/database name or select another
prior-year dataset.
```
```
Selected datasets use different currencies. Provide a conversion assumption or compare
them separately.
```
```
County-level data is not available for this dataset. Showing state-level results.
```
```
No exposure records match the current filters. Adjust filters or reset the view.
```

## Technical error report (support)

Every reportable error/job failure must capture:
server name; database name; procedure name; input parameters; user selections; timestamp;
error message; stack trace or log ID; tables checked; tables generated before failure;
current dataset; prior dataset; dataset group + combination method; currency selections;
active filters; `traceId`.

## Error email

Send the technical report to a configured recipient.

```
SUPPORT_ERROR_EMAIL   # config only — never hardcode an address
EMAIL_TRANSPORT       # smtp | graph | noop(dev)
```

- Implement behind `EmailService` (`services/email.py`) with a `noop` transport for dev so
  failures are logged, not sent, locally.
- SMTP vs Microsoft Graph is **[OPEN]** (`OPEN_QUESTIONS.md`) — keep the transport pluggable.
- Email send must be best-effort: a failed send must not mask the original error; record
  `emailSent: true|false` in the job/error record.

## Logging

Log every HTTP error and job failure with `traceId`, code, and the technical context above.
Never log secrets (tokens, passwords, connection strings).
