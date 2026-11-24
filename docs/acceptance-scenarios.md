# Acceptance scenarios for the booking rules

Written in plain words so the club can confirm them. Each one is covered by an automated test in `packages/domain/test`.
"Setting" means the club can change it (open decision in brackets); the value shown is the working default.

## Booking
1. An approved rider with a valid medical form and signed waiver can book a published class. *(eligibility)*
2. A rider who is not approved yet cannot book.
3. A rider below the class level cannot book, and is told which level is needed.
4. A medical form that will have expired by the class date blocks booking. One that is valid that day is fine.
5. A missing medical form and a missing waiver are both reported at once. Setting: required documents (OD-07), on by default.
6. A child with no linked guardian cannot book. Setting: guardian age 18 (OD-01).
7. The same rider cannot book the same class twice, or two overlapping classes.
8. A rider may hold at most 2 classes on one day. Setting.
9. Paying with a package needs at least one class left. Paying at the office does not.
10. A class that has started or is not published cannot be booked.

## Places and the waitlist
11. When one place is left and two people ask, the first gets it and the second is waitlisted. *(DB lock + `place()`)*
12. Cancelled and no-show bookings free their place.
13. A pay-at-office booking holds its place for 10 minutes, then the place is released. Setting (OD-04).
14. Only a manager or owner can confirm an unpaid office booking, and only if the club allows it. Setting (OD-14).
15. When a place opens, the longest-waiting eligible rider is offered it. Someone who is no longer eligible is skipped.
16. An offer lasts 2 hours. After that it expires and the next rider is offered. Setting.

## Cancellation
17. Cancelling 24 hours or more before the class is free and the package class goes back. Setting (OD-06).
18. Cancelling later uses the class. The club can switch this off.
19. Club and weather cancellations never cost the rider, even at the last minute.
20. A customer cannot cancel after the class has started.
21. A no-show uses the class. Setting.

## Package ledger
22. A package balance is always the sum of its entries.
23. The same event applied twice counts once (retries and double clicks are safe).
24. The last class cannot be used twice.
25. A refund for the same booking cannot be paid twice.
26. An adjustment needs a written reason. Entries are never edited or deleted.

## Horses
27. A horse that is resting, injured, on medical hold or retired cannot be assigned.
28. A horse is only used in approved arenas and for approved levels.
29. A horse cannot be in two classes at once and needs 60 minutes between sessions. Setting.
30. A horse works at most 3 sessions a day and 15 a week. Setting (OD-03).

## Scheduling
31. An arena cannot host two classes at once, and a coach cannot teach two at once. Back-to-back is fine.
32. Cancelled classes do not block a slot. Arena closures and coach time off do.
33. An override needs a manager or owner and a written reason. Impossible times and zero capacity can never be overridden.

## Not covered yet (needs the club's answer or the API)
- Customer vs staff horse choice (OD-02). Default: staff assigns.
- What customers can see: coach notes, horse names (OD-08).
- Package sharing, freezing, extending, transferring (OD-05) and branch pricing (OD-11).
- Which classes need which arena level (OD-13).
- Account deletion: lock on request, erase after 30 days, keep receipts without names.
- Receipt numbering and the daily cash close. These belong in the API tests.
