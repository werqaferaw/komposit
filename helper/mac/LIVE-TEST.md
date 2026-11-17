# komposit-helper: live test

These are the checks the smoke test can't do, because they touch real apps. Do them
together, with nothing important open: use a new, unsaved Illustrator document and an
empty After Effects project. Every script below only reads; nothing is changed or saved.

What we want to see:
1. A script runs in Illustrator, and macOS's prompt names "Komposit".
2. The text and buttons of an open After Effects dialog are read through Accessibility.
3. The heat level is reported.

## 0. Build and set up

```sh
cd /path/to/your/checkout
helper/mac/build.sh
node --test helper/mac/smoke.test.ts          # all pass
D=$(mktemp -d)
helper/mac/live-bundle.sh "$D"                 # -> $D/Komposit.app (bundle id dev.werq.komposit.livetest)

# Send one request through the "Komposit" bundle and print the answer.
# (Started with `open`, so macOS treats it as its own app, not Terminal.)
kh() {
  printf '%s\n' "$1" > "$D/in.jsonl"; rm -f "$D/out.jsonl"
  open -W -n --stdin "$D/in.jsonl" --stdout "$D/out.jsonl" --stderr "$D/err.txt" "$D/Komposit.app"
  grep -v '"ready"' "$D/out.jsonl"; cat "$D/err.txt"
}
kh '{"jsonrpc":"2.0","id":1,"method":"version"}'
```

## 1. Heat

```sh
kh '{"jsonrpc":"2.0","id":1,"method":"system.thermal"}'
```
Expect `{"state":"nominal"|"fair"|...,"lowPowerMode":...}`.

## 2. Illustrator: permission, then a script

Open Illustrator with a new, unsaved document.

```sh
# a. Not decided yet? (no prompt)
kh '{"jsonrpc":"2.0","id":1,"method":"appleEvents.permission","params":{"bundleId":"com.adobe.illustrator","ask":false}}'
#    expect "notDetermined" the first time (or "granted"/"denied" if decided before)

# b. Ask. macOS shows: "Komposit" wants access to control "Adobe Illustrator",
#    with the reason from helper/mac/Info.plist. Check the name, click Allow.
kh '{"jsonrpc":"2.0","id":1,"method":"appleEvents.permission","params":{"bundleId":"com.adobe.illustrator","ask":true}}'
#    expect "granted"

# c. A read-only script.
kh '{"jsonrpc":"2.0","id":1,"method":"appleEvents.runScript","params":{"bundleId":"com.adobe.illustrator","code":"app.name + \" \" + app.version + \", \" + app.documents.length + \" open\"","timeoutMs":20000}}'
#    expect {"result":"Adobe Illustrator 30.x, 1 open","app":"Illustrator",...}

# d. A script that fails: the app's own message comes back as a scriptError.
kh '{"jsonrpc":"2.0","id":1,"method":"appleEvents.runScript","params":{"bundleId":"com.adobe.illustrator","code":"throw new Error(\"komposit live test\")","timeoutMs":20000}}'
#    expect data.kind "scriptError" and a message containing "komposit live test"

# e. (optional) A timeout: the script sleeps 4 s, the helper waits 1 s.
kh '{"jsonrpc":"2.0","id":1,"method":"appleEvents.runScript","params":{"bundleId":"com.adobe.illustrator","code":"$.sleep(4000); 1","timeoutMs":1000}}'
#    expect data.kind "timeout" after about 1 s; Illustrator is free again after 4 s
```

Also try (optional) with Photoshop: the same `code` works with `"bundleId":"com.adobe.Photoshop"`.

## 3. After Effects: read a dialog

Open After Effects with an empty project, wait until it has finished starting,
then open a harmless dialog: **Composition > New Composition...** (leave it open).

```sh
# a. Its pid, and the dialog in the window list (layer 8 = modal).
kh '{"jsonrpc":"2.0","id":1,"method":"windows.list","params":{"ownerPrefix":"After Effects","onScreenOnly":true}}'
#    note the pid; expect dialogs.modal to list one id while the dialog is open

# b. Accessibility. Inside Komposit.app this is Komposit's own permission; the live
#    bundle is a separate app, so for this test read it from Terminal instead (which
#    may already have Accessibility). First check, no prompt:
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"ax.trusted","params":{"prompt":false}}' | out/helper/komposit-helper
#    If false: turn on Accessibility for Terminal in System Settings >
#    Privacy & Security > Accessibility (and can turn it off afterwards).

# c. Read the dialog (put the pid from step a in place of PID).
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"ax.dialog","params":{"pid":PID}}' | out/helper/komposit-helper
#    expect dialogs[0] with title "Composition Settings", some texts and buttons
#    such as "OK" and "Cancel". If text and buttons are empty, After Effects draws
#    this dialog itself and exposes nothing: note that down (1.0 then fell back to a
#    picture of the window).

# d. (optional) Press Cancel through Accessibility.
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"ax.press","params":{"pid":PID,"button":"Cancel"}}' | out/helper/komposit-helper
#    expect {"pressed":"Cancel"} and the dialog closes
```

Also worth a look: an After Effects script error, which is the dialog that matters most
(it silently blocks every later script). Run
`File > Scripts > Run Script File...` on a file containing `throw new Error("komposit live test")`,
then repeat 3a and 3c.

## 4. Clean up

```sh
rm -rf "$D"
tccutil reset AppleEvents dev.werq.komposit.livetest   # forget the live bundle's Automation answer
```
Turn Terminal's Accessibility back off if it was turned on just for this.

## Record

Write down: the prompt's wording (screenshot), each result above, the time `ms` for 2c,
and what 3c read.
