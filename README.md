# Visual Streams

A Pinterest-style, endlessly scrolling feed of images from your curated design sites, split into tabs. It runs for free on GitHub: every three hours GitHub works through your sites — their portfolio sections, category pages and every project page — gathers the images at the highest resolution each site offers, and rebuilds the website. You just open your bookmark.

## One-time setup (about 15 minutes)

1. **Create a free GitHub account** at github.com if you don't have one.
2. **Create a repository.** Click the **+** at the top right → **New repository**. Name it `visual-streams`, choose **Public**, and click **Create repository**.
   (Free accounts can only publish websites from public repositories. The site isn't listed anywhere and asks search engines not to index it, but anyone who has the link can open it.)
3. **Upload the files.** On the new repository page, click **uploading an existing file**. Open the unzipped *Visual Streams* folder, select everything inside it, and drag it all onto the page. Click **Commit changes**.
4. **Turn on the website.** Go to **Settings** → **Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
5. **Add the daily update.** Go to the **Actions** tab → **set up a workflow yourself**. Delete the sample text, then open `github-workflow.yml` from the folder, copy everything in it and paste it in. Change the file name at the top from `main.yml` to `update.yml`. Click **Commit changes…** → **Commit changes**.
6. **Wait for the first run.** That commit starts the first update automatically. You can watch it on the **Actions** tab; the first one visits all ~830 sites and takes roughly 10–20 minutes. A green tick means it's done.
7. **Bookmark your site:** `https://YOUR-GITHUB-USERNAME.github.io/visual-streams/`
   (The exact address is also shown under **Settings → Pages**.)

## Day to day

- The site updates itself every three hours. Each run continues where the last one stopped, reading up to 30 new project pages per studio, so large portfolios fill in over a day or two and new projects are picked up as they're published.
- **Tabs** switch streams; Architecture, Graphics & Branding and Editorial have filter chips. **Mix / Newest** changes the order and **Shuffle** reshuffles.
- **Click any image** to see it large. It sharpens to the highest-resolution version the studio's site offers; **Full size ↗** opens that file on its own. **See the whole project** shows every image from that project in the studio's order, and **More from this studio** shows everything collected from that studio.

## Adding, moving or removing sites

1. Open your site and click **Sources**.
2. Make your changes: paste new links, add or rename tabs, move or remove sites. Changes are kept in your browser until you publish them.
3. Click **Publish changes** and follow the three steps: the page copies your updated list, opens the right file on GitHub, and you paste and commit it.
4. The site rebuilds within a few minutes. New sites get their images on that run.

To refresh everything immediately instead of waiting for the morning: **Actions** tab → **Update Visual Streams** → **Run workflow**.

## Notes

- The coloured dot next to each site on the Sources page shows whether images were found (green), the site had none we could read (yellow), or it couldn't be reached (red). Sites built entirely in JavaScript or that block automated visits stay yellow or red.
- Images load straight from each studio's website, and every image links back to its source. Only the image addresses are stored.
- `data/sources.json` is your master list of tabs and sites. `data/sites/` holds the app's memory of each studio (images found, project pages read and still to read); it updates itself.
