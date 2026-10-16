package dev.smp.holoportal;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.File;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Level;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The custom head library from minecraft-heads.com, for the head picker.
 * <p>
 * By default this uses their public category lists (about 94,000 heads, no key needed). If an app
 * UUID from minecraft-heads.com is set in config.yml (heads.app-uuid, plus heads.api-key for a
 * license), it uses API v2 instead; without a license v2 only returns 100 demo heads. Each category is downloaded once, trimmed to
 * name, tags and texture hash, and cached in {@code plugins/HoloPortal/heads/} for a week. The
 * browser rebuilds the texture value from the hash, which DecentHolograms accepts like the original.
 * Runs on the web threads, never on the server thread.
 */
final class HeadLibrary {

    static final List<String[]> CATEGORIES = List.of(
            new String[]{"alphabet", "Letters & symbols"}, new String[]{"animals", "Animals"}, new String[]{"blocks", "Blocks"},
            new String[]{"decoration", "Decoration"}, new String[]{"food-drinks", "Food & drinks"}, new String[]{"humans", "People"},
            new String[]{"humanoid", "Humanoid"}, new String[]{"miscellaneous", "Miscellaneous"}, new String[]{"monsters", "Monsters"},
            new String[]{"plants", "Plants"});
    private static final String URL = "https://minecraft-heads.com/scripts/api.php?tags=true&cat=";
    private static final String V2 = "https://minecraft-heads.com/api/heads/";
    private static final long MAX_AGE_MS = 7L * 24 * 3600 * 1000;
    private static final Pattern HASH = Pattern.compile("textures\\.minecraft\\.net/texture/([0-9a-fA-F]+)");
    private static final int PAGE = 60;

    /** name, tags, hash per head. */
    private record Head(String name, String tags, String hash, String search) { }

    private final HoloPortalPlugin plugin;
    private final Map<String, List<Head>> loaded = new ConcurrentHashMap<>();
    private volatile List<String[]> v2Categories;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).followRedirects(HttpClient.Redirect.NORMAL).build();

    HeadLibrary(HoloPortalPlugin plugin) {
        this.plugin = plugin;
    }

    JsonObject categories() {
        JsonObject o = new JsonObject();
        o.addProperty("enabled", enabled());
        o.addProperty("source", useV2() ? "v2" : "v1");
        JsonArray a = new JsonArray();
        for (String[] c : enabled() ? categoryList() : CATEGORIES) {
            JsonObject e = new JsonObject();
            e.addProperty("id", c[0]);
            e.addProperty("label", c[1]);
            e.addProperty("cached", loaded.containsKey(c[0]) || cacheFile(c[0]).exists());
            a.add(e);
        }
        o.add("categories", a);
        return o;
    }

    /** One page of heads in a category ("all" searches every category), optionally filtered by a search. */
    JsonObject search(String category, String query, int page) {
        if (!enabled()) throw new ApiException(403, "The head library is turned off in plugins/HoloPortal/config.yml (heads.library).");
        List<Head> pool = new ArrayList<>();
        if (category == null || category.isBlank() || category.equals("all")) {
            for (String[] c : categoryList()) pool.addAll(load(c[0]));
        } else {
            if (categoryList().stream().noneMatch(c -> c[0].equals(category))) throw new ApiException(400, "Unknown category " + category);
            pool = load(category);
        }
        String q = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        List<Head> hits = q.isEmpty() ? pool : pool.stream().filter(h -> h.search.contains(q)).toList();
        int pages = Math.max(1, (hits.size() + PAGE - 1) / PAGE);
        int p = Math.max(0, Math.min(page, pages - 1));
        JsonArray list = new JsonArray();
        for (Head h : hits.subList(p * PAGE, Math.min(hits.size(), (p + 1) * PAGE))) {
            JsonObject o = new JsonObject();
            o.addProperty("name", h.name);
            o.addProperty("tags", h.tags);
            o.addProperty("hash", h.hash);
            list.add(o);
        }
        JsonObject out = new JsonObject();
        out.addProperty("total", hits.size());
        out.addProperty("page", p);
        out.addProperty("pages", pages);
        out.add("heads", list);
        return out;
    }

    private boolean enabled() {
        return plugin.getConfig().getBoolean("heads.library", true);
    }

    private boolean useV2() {
        return !plugin.getConfig().getString("heads.app-uuid", "").isBlank();
    }

    private List<String[]> categoryList() {
        if (!useV2()) return CATEGORIES;
        List<String[]> cats = v2Categories;
        if (cats != null) return cats;
        try {
            List<String[]> out = new ArrayList<>();
            for (JsonElement e : v2("categories", "").getAsJsonArray("data")) {
                JsonObject c = e.getAsJsonObject();
                out.add(new String[]{"v2-" + c.get("id").getAsString(), str(c, "n")});
            }
            v2Categories = out;
            return out;
        } catch (Exception e) {
            plugin.getLogger().warning("minecraft-heads.com API v2 failed (" + e.getMessage() + "); using the public lists instead.");
            return CATEGORIES;
        }
    }

    /** Calls API v2 and returns the response, logging its warnings (e.g. demo mode). */
    private JsonObject v2(String endpoint, String query) throws Exception {
        String app = plugin.getConfig().getString("heads.app-uuid", "").trim();
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(V2 + endpoint + "?app_uuid=" + java.net.URLEncoder.encode(app, StandardCharsets.UTF_8) + query))
                .timeout(Duration.ofSeconds(60))
                .header("User-Agent", "HoloPortal/" + plugin.getPluginMeta().getVersion() + " (DecentHolograms web editor)");
        String key = plugin.getConfig().getString("heads.api-key", "").trim();
        if (!key.isEmpty()) b.header("api-key", key);
        HttpResponse<String> res = http.send(b.GET().build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonObject o = JsonParser.parseString(res.body()).getAsJsonObject();
        if (o.has("error")) throw new IllegalStateException(o.get("error").getAsString());
        if (o.has("warnings")) for (JsonElement w : o.getAsJsonArray("warnings")) plugin.getLogger().info("minecraft-heads.com: " + w.getAsString());
        return o;
    }

    private List<Head> load(String category) {
        List<Head> cached = loaded.get(category);
        if (cached != null) return cached;
        synchronized (this) {
            cached = loaded.get(category);
            if (cached != null) return cached;
            File file = cacheFile(category);
            List<Head> heads = null;
            if (file.exists() && System.currentTimeMillis() - file.lastModified() < MAX_AGE_MS) heads = readCache(file);
            if (heads == null) {
                try {
                    heads = download(category);
                    writeCache(file, heads);
                } catch (Exception e) {
                    plugin.getLogger().log(Level.WARNING, "Couldn't download the " + category + " heads from minecraft-heads.com", e);
                    heads = file.exists() ? readCache(file) : null; // an old cache is better than nothing
                    if (heads == null) throw new ApiException(502, "Couldn't reach minecraft-heads.com: " + e.getMessage());
                }
            }
            loaded.put(category, heads);
            return heads;
        }
    }

    private List<Head> download(String category) throws Exception {
        if (category.startsWith("v2-")) {
            List<Head> heads = new ArrayList<>();
            for (int page = 0; page < 20; page++) {
                JsonArray data = v2("custom-heads", "&category_id=" + category.substring(3) + (page > 0 ? "&page=" + page : "")).getAsJsonArray("data");
                for (JsonElement e : data) {
                    if (!e.isJsonObject()) continue;
                    JsonObject h = e.getAsJsonObject();
                    String hash = str(h, "u");
                    if (hash.isEmpty() && h.has("v")) hash = hashOf(str(h, "v"));
                    if (hash != null && !hash.isEmpty()) heads.add(head(str(h, "n"), "", hash.toLowerCase(Locale.ROOT)));
                }
                if (data.size() < 10000) break; // 10,000 per page
            }
            return heads;
        }
        HttpRequest req = HttpRequest.newBuilder(URI.create(URL + category))
                .timeout(Duration.ofSeconds(60))
                .header("User-Agent", "HoloPortal/" + plugin.getPluginMeta().getVersion() + " (DecentHolograms web editor)")
                .GET().build();
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (res.statusCode() != 200) throw new IllegalStateException("HTTP " + res.statusCode());
        List<Head> heads = new ArrayList<>();
        for (JsonElement e : JsonParser.parseString(res.body()).getAsJsonArray()) {
            JsonObject o = e.getAsJsonObject();
            String hash = hashOf(str(o, "value"));
            if (hash == null) continue;
            heads.add(head(str(o, "name"), str(o, "tags"), hash));
        }
        return heads;
    }

    /** The texture hash inside a base64 texture value. */
    static String hashOf(String value) {
        try {
            Matcher m = HASH.matcher(new String(Base64.getDecoder().decode(value.trim()), StandardCharsets.UTF_8));
            return m.find() ? m.group(1).toLowerCase(Locale.ROOT) : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static Head head(String name, String tags, String hash) {
        return new Head(name, tags, hash, (name + " " + tags).toLowerCase(Locale.ROOT));
    }

    private File cacheFile(String category) {
        return new File(new File(plugin.getDataFolder(), "heads"), category + ".json");
    }

    private void writeCache(File file, List<Head> heads) {
        try {
            JsonArray a = new JsonArray();
            for (Head h : heads) {
                JsonArray row = new JsonArray();
                row.add(h.name);
                row.add(h.tags);
                row.add(h.hash);
                a.add(row);
            }
            file.getParentFile().mkdirs();
            Files.writeString(file.toPath(), new Gson().toJson(a), StandardCharsets.UTF_8);
        } catch (Exception e) {
            plugin.getLogger().warning("Couldn't cache heads: " + e.getMessage());
        }
    }

    private List<Head> readCache(File file) {
        try {
            List<Head> heads = new ArrayList<>();
            for (JsonElement e : JsonParser.parseString(Files.readString(file.toPath(), StandardCharsets.UTF_8)).getAsJsonArray()) {
                JsonArray row = e.getAsJsonArray();
                heads.add(head(row.get(0).getAsString(), row.get(1).getAsString(), row.get(2).getAsString()));
            }
            return heads;
        } catch (Exception e) {
            return null;
        }
    }

    private static String str(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? "" : e.getAsString();
    }
}
