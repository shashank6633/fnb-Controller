/*
 * Copyright 2020 Google Inc.  Licensed under the Apache License, Version 2.0.
 */
package com.akanhyd.fnb.captainapp;

import android.Manifest;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

import java.util.ArrayList;
import java.util.List;

/**
 * TWA launcher. On first open it asks for the call-log + phone permissions the
 * CRM "exact callback duration" feature needs, THEN opens the web app. Granting
 * is OPTIONAL — if denied, the app still opens and that feature just falls back
 * to an approximate duration. Using shouldLaunchImmediately()=false + launchTwa()
 * is the documented androidbrowserhelper hook for running code before the TWA.
 */
public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {

    private static final int PERM_REQ = 7011;
    private boolean launched = false;

    /** Don't auto-launch the TWA — we launch it ourselves after the prompt. */
    @Override
    protected boolean shouldLaunchImmediately() {
        return false;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
        requestPermissionsThenLaunch();
    }

    private void requestPermissionsThenLaunch() {
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                List<String> need = new ArrayList<>();
                if (checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
                    need.add(Manifest.permission.READ_CALL_LOG);
                }
                if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
                    need.add(Manifest.permission.CALL_PHONE);
                }
                if (!need.isEmpty()) {
                    requestPermissions(need.toArray(new String[0]), PERM_REQ);
                    return; // launch continues in onRequestPermissionsResult
                }
            }
        } catch (Exception ignored) { /* never block app launch on the prompt */ }
        launchOnce();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // Grant or deny — proceed into the app either way (feature degrades gracefully).
        if (requestCode == PERM_REQ) launchOnce();
    }

    private void launchOnce() {
        if (launched) return;
        launched = true;
        try { launchTwa(); } catch (Exception ignored) { }
    }

    @Override
    protected Uri getLaunchingUrl() {
        return super.getLaunchingUrl();
    }
}
