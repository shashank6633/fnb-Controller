package com.akanhyd.fnb.captainapp;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.CallLog;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * AKAN Captain — exact callback-duration bridge for the Call-to-Table CRM.
 *
 * The web app (running as a TWA in this APK) opens
 *   akancall://log?phone=+91XXXXXXXXXX&recovery=<id>&ret=/crm-calls/recovery
 * This activity:
 *   1. asks for READ_CALL_LOG (+ CALL_PHONE for one-tap dialing),
 *   2. places the call from the GRE's own SIM,
 *   3. when the call ends, reads the EXACT duration from the device call log,
 *   4. deep-links back into the web app with the measured values:
 *        https://fnb.akanhyd.com<ret>?cb=1&cb_phone=..&cb_duration=..&cb_connected=..
 *          &cb_at=..&cb_src=calllog|approx&cb_recovery=..
 * The web page (already authenticated) submits the callback — no credentials
 * or tokens ever live in this APK.
 *
 * If READ_CALL_LOG is denied or the log row can't be found, it falls back to
 * the activity's own pause→resume wall-time (cb_src=approx) so the GRE still
 * gets a prefilled sheet to confirm.
 */
public class CallLoggerActivity extends Activity {

    private static final int REQ_PERMS = 71;
    private static final String HOST = "https://fnb.akanhyd.com";
    private static final long LOG_POLL_MS = 1500;
    private static final int LOG_POLL_TRIES = 8;

    private String phone = "";
    private String recoveryId = "";
    private String returnPath = "/crm-calls/recovery";

    private boolean callPlaced = false;
    private boolean finishing = false;
    private long callStartMarker = 0L;   // wall clock just before launching the dialer
    private long pausedAt = 0L;          // for the approx fallback
    private long approxTalkMs = 0L;

    private TextView statusView;
    private Button callButton;
    private Button doneButton;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int pollsLeft = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Uri data = getIntent() != null ? getIntent().getData() : null;
        if (data != null) {
            String p = data.getQueryParameter("phone");
            String r = data.getQueryParameter("recovery");
            String ret = data.getQueryParameter("ret");
            if (p != null) phone = p.trim();
            if (r != null) recoveryId = r.trim();
            if (ret != null && ret.startsWith("/")) returnPath = ret;
        }
        if (phone.isEmpty()) { // nothing to do — bounce straight back
            returnToWeb("approx", 0, false);
            return;
        }

        buildUi();

        // SECURITY: this activity is exported (Chrome must be able to launch it
        // via intent://), so ANY app or webpage could feed it a number. Never
        // auto-dial — the human always sees the number and taps "Call" first.
        setStatus("Ready to call\n\n" + phone);
        showCallButton();

        if (Build.VERSION.SDK_INT >= 23 && !hasPerm(Manifest.permission.READ_CALL_LOG)) {
            requestPermissions(new String[] {
                Manifest.permission.READ_CALL_LOG, Manifest.permission.CALL_PHONE,
            }, REQ_PERMS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] grants) {
        super.onRequestPermissionsResult(code, perms, grants);
        // No action — the call fires only from the explicit "Call" tap; a denied
        // READ_CALL_LOG just means the approx fallback will be used afterwards.
    }

    private void startCall() {
        callStartMarker = System.currentTimeMillis();
        callPlaced = true;
        pausedAt = 0L;
        setStatus("Calling " + phone + "…\n\nCome back to this screen after the call ends.");
        Intent call;
        if (hasPerm(Manifest.permission.CALL_PHONE)) {
            call = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(phone)));
        } else {
            call = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(phone)));
        }
        try {
            startActivity(call);
        } catch (ActivityNotFoundException | SecurityException e) {
            // No dialer / OEM restriction — nothing we can measure natively.
            returnToWeb("approx", 0, false);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (callPlaced && pausedAt == 0L) pausedAt = System.currentTimeMillis();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!callPlaced || finishing) return;
        // Only react to a RETURN from the dialer: without an observed pause the
        // first resume (right after onCreate/tap) would start polling while the
        // user is still dialing and could match nothing / show the wrong state.
        if (pausedAt == 0L) return;
        approxTalkMs = System.currentTimeMillis() - pausedAt;
        if (!hasPerm(Manifest.permission.READ_CALL_LOG)) {
            // Denied — no point polling for 12s; go straight to the estimate path.
            setStatus("Call-log permission is off.\nTap to log with the estimated duration.");
            showDoneButton("Log with estimate");
            return;
        }
        setStatus("Call finished?\nReading the call log…");
        pollsLeft = LOG_POLL_TRIES;
        handler.removeCallbacksAndMessages(null);
        pollCallLog();
    }

    @Override
    protected void onDestroy() {
        // Covers Back-press and system-initiated destruction: without this, a
        // pending poll could fire after finish() and force-reopen the browser.
        finishing = true;
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    /** The call-log row appears a moment after hang-up — poll briefly for it. */
    private void pollCallLog() {
        if (finishing) return;
        long[] found = queryNewestOutgoing();
        if (found != null) {
            returnToWeb("calllog", (int) found[0], found[0] > 0);
            return;
        }
        pollsLeft--;
        if (pollsLeft <= 0) {
            // Row never showed (permission denied / OEM quirk / still on the call).
            setStatus("Couldn't read the call log.\nTap the button to log the call with an estimated duration.");
            showDoneButton("Log with estimate");
            return;
        }
        handler.postDelayed(this::pollCallLog, LOG_POLL_MS);
    }

    /** @return {durationSec, dateMs} of the newest OUTGOING call to our number
     *          placed after the start marker, or null when absent/denied. */
    private long[] queryNewestOutgoing() {
        if (!hasPerm(Manifest.permission.READ_CALL_LOG)) return null;
        String suffix = digitSuffix(phone);
        if (suffix.isEmpty()) return null;
        Cursor c = null;
        try {
            // DATE is the call's placement time, which is always AFTER the
            // marker (stamped at the "Call" tap) — no fudge window, so an
            // immediate earlier call to the same number can never be matched.
            c = getContentResolver().query(
                CallLog.Calls.CONTENT_URI,
                new String[] { CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION },
                CallLog.Calls.DATE + " >= ? AND " + CallLog.Calls.TYPE + " = ?",
                new String[] {
                    String.valueOf(callStartMarker),
                    String.valueOf(CallLog.Calls.OUTGOING_TYPE),
                },
                CallLog.Calls.DATE + " DESC");
            if (c == null) return null;
            int scanned = 0;
            while (c.moveToNext() && scanned < 15) {
                scanned++;
                String num = c.getString(0);
                if (num == null) continue;
                if (digitSuffix(num).equals(suffix)) {
                    long duration = c.getLong(3);
                    long date = c.getLong(2);
                    return new long[] { duration, date };
                }
            }
            return null;
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.close();
        }
    }

    /** Last up-to-10 digits — SIM call logs store numbers in varied formats. */
    private static String digitSuffix(String raw) {
        StringBuilder digits = new StringBuilder();
        for (char ch : raw.toCharArray()) if (ch >= '0' && ch <= '9') digits.append(ch);
        String d = digits.toString();
        return d.length() <= 10 ? d : d.substring(d.length() - 10);
    }

    /** Deep-link back into the web app (verified TWA link → opens in-app). */
    private void returnToWeb(String source, int durationSec, boolean connected) {
        if (finishing) return;
        finishing = true;
        handler.removeCallbacksAndMessages(null);
        String sep = returnPath.contains("?") ? "&" : "?";
        String url = HOST + returnPath + sep
            + "cb=1"
            + "&cb_phone=" + Uri.encode(phone)
            + "&cb_duration=" + Math.max(0, durationSec)
            + "&cb_connected=" + (connected ? "1" : "0")
            + "&cb_at=" + Uri.encode(isoNow())
            + "&cb_src=" + Uri.encode(source)
            + (recoveryId.isEmpty() ? "" : "&cb_recovery=" + Uri.encode(recoveryId));
        Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        view.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
            startActivity(view);
        } catch (ActivityNotFoundException e) { /* no browser — nothing else to do */ }
        finish();
    }

    private static String isoNow() {
        java.text.SimpleDateFormat fmt = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US);
        fmt.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return fmt.format(new java.util.Date());
    }

    private boolean hasPerm(String perm) {
        if (Build.VERSION.SDK_INT < 23) return true;
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    // ── Minimal programmatic UI (no layout resources needed) ────────────────

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.parseColor("#FBF6F0"));
        int pad = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 28, getResources().getDisplayMetrics());
        root.setPadding(pad, pad, pad, pad);

        statusView = new TextView(this);
        statusView.setTextColor(Color.parseColor("#1C0F05"));
        statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        statusView.setGravity(Gravity.CENTER);
        statusView.setText("Preparing call…");
        root.addView(statusView);

        // Explicit dial trigger — the human confirms the number before any call
        // is placed (this activity is exported; auto-dialing would let any app
        // or webpage place paid calls).
        callButton = new Button(this);
        callButton.setText("Call now");
        callButton.setVisibility(android.view.View.GONE);
        callButton.setOnClickListener(v -> {
            callButton.setVisibility(android.view.View.GONE);
            startCall();
        });
        LinearLayout.LayoutParams kp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        kp.topMargin = pad;
        kp.gravity = Gravity.CENTER_HORIZONTAL;
        root.addView(callButton, kp);

        doneButton = new Button(this);
        doneButton.setText("I've finished the call");
        doneButton.setVisibility(android.view.View.GONE);
        doneButton.setOnClickListener(v -> {
            long[] found = queryNewestOutgoing();
            if (found != null) returnToWeb("calllog", (int) found[0], found[0] > 0);
            else returnToWeb("approx", (int) Math.max(0, approxTalkMs / 1000), approxTalkMs > 15000);
        });
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        bp.topMargin = pad;
        bp.gravity = Gravity.CENTER_HORIZONTAL;
        root.addView(doneButton, bp);

        Button cancel = new Button(this);
        cancel.setText("Cancel");
        cancel.setOnClickListener(v -> { finishing = true; finish(); });
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cp.topMargin = pad / 2;
        cp.gravity = Gravity.CENTER_HORIZONTAL;
        root.addView(cancel, cp);

        setContentView(root);
    }

    private void setStatus(String text) {
        if (statusView != null) statusView.setText(text);
    }

    private void showDoneButton(String label) {
        if (doneButton != null) {
            doneButton.setText(label);
            doneButton.setVisibility(android.view.View.VISIBLE);
        }
    }

    private void showCallButton() {
        if (callButton != null) {
            callButton.setText("Call " + phone);
            callButton.setVisibility(android.view.View.VISIBLE);
        }
    }
}
