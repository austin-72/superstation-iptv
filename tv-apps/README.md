# TV apps

Three small apps that put the player on a TV's home screen. Each one does a single thing: it asks once for your
server's address, remembers it, and opens it full screen. Everything you see after that is the server's own pages,
the same as in the TV's browser, so there is nothing else to keep up to date here.

What you gain over the TV's browser: an icon on the home screen, no address bar, the remote's Back button handled by
the app (Back at Home, twice, leaves), and on Samsung the coloured, number and media buttons.

> **Not tried on real TVs.** These were written from each platform's documentation and checked as far as that goes
> without the hardware: the page that asks for the address was run in a desktop browser, and nothing here was
> installed on a television. Expect to fix small things. Reports are welcome.

| Folder | For | You need |
|---|---|---|
| `android/` | Android TV, Google TV, Fire TV (also phones and tablets) | Nothing: download the APK from the latest release |
| `tizen/` | Samsung TVs (2016 and later) | Tizen Studio and the TV in developer mode |
| `webos/` | LG TVs (webOS 3 and later) | LG's webOS CLI and the Developer Mode app on the TV |

There is no Roku app. Roku doesn't run web pages: an app there has to be written again from nothing in Roku's own
language, which is a second player to maintain, not a wrapper. Apple TV is the same story.

## Changing the server's address

- **Samsung and LG:** when the app starts it says *Opening …* for three seconds. Press **Up** then.
- **Android TV and Fire TV:** press **Menu** on the remote, or hold **Back**.

## Android TV, Google TV, Fire TV

**Download it:** every release comes with the app ready to install, `superstation-tv.apk`, on the
[Releases](https://github.com/austin-72/superstation-iptv/releases/latest) page. This address is always the newest one, which is handy for typing into a TV:

```
https://github.com/austin-72/superstation-iptv/releases/latest/download/superstation-tv.apk
```

Put it on the TV:

- **Fire TV:** install the free **Downloader** app from the Amazon store. Then Settings → My Fire TV → Developer
  options → *Install unknown apps* → turn it on for Downloader. (No *Developer options*? Settings → My Fire TV →
  About → press the device's name seven times.) Open Downloader, type the address above, and install.
- **Android TV / Google TV:** install **Downloader** from the Play Store the same way, or download the APK on a phone
  and send it over with an app such as *Send Files to TV*. Allow installing unknown apps for the app you use (Settings
  → Apps → Security & restrictions, or Settings → Privacy → Security). Or `adb install superstation-tv.apk`.

The first time it opens, it asks for your server's address (the one you open in a browser, such as
`http://192.168.1.20:8080`).

**Updating:** the app is signed with a different key on each build, so remove the old one before installing a newer
one (it only remembers the server's address). You rarely need to: everything you see is the server's own pages, so
it's up to date whenever the server is.

**Building it yourself** (a plain Android project with one screen and no libraries): open the `android` folder in
Android Studio, let it sync, then *Build → Build APK(s)*. Or on your own copy of this repository on GitHub: *Actions*
→ *Android TV app* → *Run workflow*, and download `superstation-tv` from the run's page.

## Samsung (Tizen)

1. Install [Tizen Studio](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html)
   with the TV extensions, and create a Samsung certificate in its Certificate Manager.
2. On the TV: Apps → press 1 2 3 4 5 on the remote → Developer mode **On**, with your computer's IP address. Restart the TV.
3. In Tizen Studio: *File → New → Tizen Project → Template → TV → Web Application → Basic Project*. Then replace the
   files it made (`index.html`, `config.xml`, the `css` and `js` folders, the icon) with the ones in `tizen/`.
   Keep the package id Tizen Studio put in its own `config.xml`: copy it into the two `AbCdEfGhIj` places.
4. Connect to the TV in *Device Manager* (Remote Device Manager → the TV's IP), then right-click the project →
   *Run As → Tizen Web Application*.

An app installed this way stays on the TV; Samsung's developer certificates are tied to the TVs you registered.

## LG (webOS)

1. Install the [webOS CLI](https://webostv.developer.lge.com/develop/tools/cli-installation) (`npm install -g @webos-tools/cli`).
2. On the TV: install the **Developer Mode** app from the LG Content Store, sign in with an LG developer account,
   turn Dev Mode on and restart. Turn on *Key Server* in that app.
3. On your computer, from this folder:

   ```
   ares-setup-device            (add: a name such as tv, the TV's IP address, port 9922, user prisoner)
   ares-novacom --device tv --getkey      (asks for the passphrase shown in the Developer Mode app)
   ares-package webos
   ares-install --device tv org.superstation.tv_1.0.0_all.ipk
   ```

LG's developer mode lasts a limited time. The Developer Mode app shows how long is left and has an *Extend* button;
when the time runs out, apps installed this way are removed. That is LG's rule for apps that aren't in its store.

## What's in them

`tizen/` and `webos/` share the same three files (`index.html`, `app.css`, `app.js`: the page that asks for the
address) plus each platform's own description file and icons. `android/` is `MainActivity.java`, a manifest, the
icons and three Gradle files.

The server's pages already know these TVs (`web/js/tv.js`, `web/js/keymap.js`, `web/js/compat.js`): arrow-key
navigation, the Back key, Samsung's remote buttons. Back at Home, pressed twice, leaves the app (`V.leaveApp` in
`web/js/tv.js`).
