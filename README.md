# Event Settlement

A browser tool for paying event vendors per terminal (TID) from a team Google Sheet.

- **Source of truth:** the team's settlement spreadsheet (tab `RAW data`). The tool reads it with the
  signed-in user's own Google account through the Google Sheets API. There is no server and no database.
- **What it writes:** the payout date in the `Settleted` column (as text, `23-Nov 2026`), new rows from
  the Import page, and, only when asked, corrected dates from the Data check page. Every payout is also
  recorded in a separate Payout Log spreadsheet (tabs `Payouts`, `Transactions`, `Banks`, `Locks`).
- **Who can use it:** anyone whose Google account can edit both spreadsheets. Access is controlled by
  Google Sheets sharing, nothing else. No passwords, keys or data are stored in this repository.

## Rules the tool enforces

1. A transaction counts on its own calendar date (no midnight cut-off).
2. A row whose `Settleted` is anything other than `0` is paid and is never counted again,
   even if the TID moves to another vendor.
3. The same transaction ID (`TX-...`) on two rows is counted once.
4. Before writing, the tool takes a lock, reads the sheet again and recomputes. If anything changed
   since the user reviewed the numbers, nothing is written.
5. After writing, it reads the cells back. A returned transfer is undone from the Payouts page,
   which puts `0` back only on rows that still carry that payout's date.
6. Day and month swapped by pasting `dd/mm/yyyy` text into an `en_US` sheet are corrected in memory from the
   transaction order (TX numbers grow with time), and shown on the Data check page.

## Pages

| Page | Use |
| --- | --- |
| Settle a TID | Pick a TID, see every day paid or unpaid, choose dates, mark paid on a payout date |
| Sales request | Open the Sales file, check every line, mark paid and download the bank bulk file |
| Search | Find any transaction by TID, TRX ID, card digits, auth ID, amount or date |
| Unpaid | Unpaid money per TID |
| Payouts | Every payout made with the tool: bank file again, breakdown, undo |
| Import | Add the Kashier transactions export to `RAW data` without duplicates |
| Data check | Unpaid rows with swapped dates, duplicates, missing dates |

## Setup

The tool opens from a team link of the form
`https://<host>/event-settlement/#c=<OAuth client ID>&s=<settlement sheet ID>&l=<payout log ID>&h=<domain>`.
The values are kept in the browser (localStorage) and removed from the address bar.
`demo.html` runs the same tool on invented data, with nothing sent to Google.

The OAuth client is a Google Cloud "Web application" client with this site's origin as an authorized
JavaScript origin, on an Internal consent screen, with the Google Sheets API enabled.

## Third-party files

- `vendor/xlsx.full.min.js`: SheetJS Community Edition, Apache License 2.0 (`vendor/xlsx.LICENSE`).
- `fonts/`: IBM Plex Sans, IBM Plex Sans Arabic and IBM Plex Mono, SIL Open Font License 1.1 (`fonts/OFL-LICENSE.txt`).
