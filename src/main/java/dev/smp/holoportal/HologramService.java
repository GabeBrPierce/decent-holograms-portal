package dev.smp.holoportal;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import eu.decentsoftware.holograms.api.DecentHologramsAPI;
import eu.decentsoftware.holograms.api.actions.Action;
import eu.decentsoftware.holograms.api.actions.ActionType;
import eu.decentsoftware.holograms.api.actions.ClickType;
import eu.decentsoftware.holograms.api.holograms.Hologram;
import eu.decentsoftware.holograms.api.holograms.HologramLine;
import eu.decentsoftware.holograms.api.holograms.HologramManager;
import eu.decentsoftware.holograms.api.holograms.HologramPage;
import eu.decentsoftware.holograms.api.holograms.enums.EnumFlag;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.configuration.InvalidConfigurationException;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.EntityType;
import org.bukkit.entity.Player;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

/**
 * Reads holograms from DecentHolograms and saves edits back.
 * <p>
 * A save writes the hologram's YAML file in DH's own format and has DH load it again with
 * {@link Hologram#fromFile}, the same path {@code /dh reload} uses, so anything DH can store in a
 * file the editor can set. If DH rejects the file, the previous file is put back and reloaded.
 * Everything that touches DH runs on the server thread.
 */
final class HologramService {

    private static final Pattern NAME = Pattern.compile("[a-zA-Z0-9_-]+");
    private static final List<String> BUILT_IN_ANIMATIONS = List.of("typewriter", "wave", "burn", "scroll", "colors");
    private static final Gson GSON = new Gson();

    private final HoloPortalPlugin plugin;

    HologramService(HoloPortalPlugin plugin) {
        this.plugin = plugin;
    }

    // ------------------------------------------------------------------ reads

    JsonArray list() throws Exception {
        return sync(() -> {
            JsonArray out = new JsonArray();
            List<Hologram> holograms = new ArrayList<>(manager().getHolograms());
            holograms.sort(Comparator.comparing(h -> h.getName().toLowerCase(Locale.ROOT)));
            for (Hologram h : holograms) {
                JsonObject o = new JsonObject();
                Location loc = h.getLocation();
                o.addProperty("name", h.getName());
                o.addProperty("world", loc.getWorld() == null ? "" : loc.getWorld().getName());
                o.addProperty("x", round(loc.getX()));
                o.addProperty("y", round(loc.getY()));
                o.addProperty("z", round(loc.getZ()));
                o.addProperty("enabled", h.isEnabled());
                o.addProperty("pages", h.getPages().size());
                o.addProperty("lines", h.getPages().isEmpty() ? 0 : h.getPage(0).size());
                o.addProperty("preview", previewLine(h));
                out.add(o);
            }
            // Holograms in worlds that aren't loaded wait in DH's "to load" list and can't be edited.
            for (Map.Entry<String, Set<String>> e : manager().getToLoad().entrySet()) {
                for (String path : e.getValue()) {
                    JsonObject o = new JsonObject();
                    String file = new File(path).getName();
                    o.addProperty("name", file.endsWith(".yml") ? file.substring(0, file.length() - 4) : file);
                    o.addProperty("world", e.getKey());
                    o.addProperty("unloaded", true);
                    out.add(o);
                }
            }
            return out;
        });
    }

    private static List<String> allowedEntities() {
        try {
            return eu.decentsoftware.holograms.api.utils.entity.DecentEntityType.getAllowedEntityTypeNames().stream()
                    .filter(n -> !n.equals("UNKNOWN")).sorted().toList();
        } catch (Throwable t) {
            // Older DH builds without this helper: living entities are always safe.
            return Arrays.stream(EntityType.values()).filter(e -> e != EntityType.UNKNOWN && e.isAlive()).map(Enum::name).sorted().toList();
        }
    }

    /** The first text line of the first page, for the sidebar. */
    private static String previewLine(Hologram h) {
        if (h.getPages().isEmpty()) return "";
        for (HologramLine line : h.getPage(0).getLines()) {
            String c = line.getContent();
            if (c != null && !c.isBlank() && !c.startsWith("#")) return c;
        }
        return "";
    }

    JsonObject get(String name) throws Exception {
        return sync(() -> {
            JsonObject o = toJson(require(name));
            o.addProperty("fingerprint", fingerprint(o));
            return o;
        });
    }

    String yaml(String name) throws Exception {
        return sync(() -> {
            Hologram h = require(name);
            File file = file(h);
            if (file == null || !file.exists()) return yamlFor(toJson(h));
            return Files.readString(file.toPath(), StandardCharsets.UTF_8);
        });
    }

    /** Everything the editor needs for its dropdowns. */
    JsonObject meta() throws Exception {
        return sync(() -> {
            JsonObject o = new JsonObject();
            JsonArray worlds = new JsonArray();
            for (World w : Bukkit.getWorlds()) worlds.add(w.getName());
            o.add("worlds", worlds);

            JsonArray players = new JsonArray();
            for (Player p : Bukkit.getOnlinePlayers()) {
                Location l = p.getLocation();
                JsonObject po = new JsonObject();
                po.addProperty("name", p.getName());
                po.addProperty("world", l.getWorld().getName());
                po.addProperty("x", round(l.getX()));
                po.addProperty("y", round(l.getY()));
                po.addProperty("z", round(l.getZ()));
                po.addProperty("yaw", Math.round(l.getYaw() * 10) / 10.0);
                players.add(po);
            }
            o.add("players", players);

            o.add("materials", strings(Arrays.stream(Material.values())
                    .filter(m -> !m.name().startsWith("LEGACY_") && m.isItem() && !m.isAir())
                    .map(Enum::name).sorted().toList()));
            // DH's own list of entities it can show; the rest are blacklisted (they need data a fake entity can't have).
            List<String> allowed = allowedEntities();
            o.add("entities", strings(allowed));
            o.add("entityBlacklist", strings(Arrays.stream(EntityType.values())
                    .filter(t -> t != EntityType.UNKNOWN && !allowed.contains(t.name()))
                    .map(Enum::name).sorted().toList()));
            o.add("actionTypes", strings(ActionType.getActionTypes().stream().map(ActionType::getName).sorted().toList()));
            o.add("clickTypes", strings(Arrays.stream(ClickType.values()).map(Enum::name).toList()));
            o.add("flags", strings(Arrays.stream(EnumFlag.values()).map(Enum::name).toList()));

            List<String> animations = new ArrayList<>(BUILT_IN_ANIMATIONS);
            File[] files = new File(DecentHologramsAPI.get().getDataFolder(), "animations").listFiles((d, n) -> n.endsWith(".yml"));
            if (files != null) for (File f : files) animations.add(f.getName().substring(0, f.getName().length() - 4));
            o.add("animations", strings(animations));

            YamlConfiguration dh = YamlConfiguration.loadConfiguration(new File(DecentHologramsAPI.get().getDataFolder(), "config.yml"));
            JsonObject defaults = new JsonObject();
            defaults.addProperty("displayRange", dh.getInt("defaults.display-range", 48));
            defaults.addProperty("updateRange", dh.getInt("defaults.update-range", 48));
            defaults.addProperty("updateInterval", dh.getInt("defaults.update-interval", 20));
            defaults.addProperty("text", dh.getString("defaults.text", "Blank Line"));
            JsonObject heights = new JsonObject();
            heights.addProperty("TEXT", dh.getDouble("defaults.height.text", 0.3));
            heights.addProperty("ICON", dh.getDouble("defaults.height.icon", 0.6));
            heights.addProperty("HEAD", dh.getDouble("defaults.height.head", 0.75));
            heights.addProperty("SMALLHEAD", dh.getDouble("defaults.height.smallhead", 0.6));
            heights.addProperty("ENTITY", 1.0);
            defaults.add("heights", heights);
            o.add("defaults", defaults);
            return o;
        });
    }

    // ------------------------------------------------------------------ writes

    /**
     * Creates, edits or renames a hologram. {@code original} is the name it had when the editor
     * loaded it (null for a new one) and {@code fingerprint} what it looked like then, so an
     * in-game change made in the meantime isn't silently overwritten.
     */
    JsonObject save(String original, String fingerprint, JsonObject dto) throws Exception {
        return sync(() -> {
            String name = str(dto, "name").trim();
            if (!NAME.matcher(name).matches()) throw new ApiException(400, "Names can only use letters, numbers, _ and -.");
            checkCurrent(original, fingerprint);
            String world = str(dto, "world");
            if (Bukkit.getWorld(world) == null) throw new ApiException(400, "World '" + world + "' isn't loaded.");
            Hologram h = apply(original, name, yamlFor(dto));
            JsonObject o = toJson(h);
            o.addProperty("fingerprint", fingerprint(o));
            return o;
        });
    }

    /** Replaces a hologram's file with hand-written YAML. */
    JsonObject saveYaml(String name, String fingerprint, String yaml) throws Exception {
        return sync(() -> {
            checkCurrent(name, fingerprint);
            YamlConfiguration test = new YamlConfiguration();
            try {
                test.loadFromString(yaml);
            } catch (InvalidConfigurationException e) {
                throw new ApiException(400, "That isn't valid YAML: " + firstLine(e.getMessage()));
            }
            if (!test.isString("location")) throw new ApiException(400, "The YAML needs a location: world:x:y:z line.");
            Hologram h = apply(name, name, yaml);
            JsonObject o = toJson(h);
            o.addProperty("fingerprint", fingerprint(o));
            return o;
        });
    }

    void delete(String name) throws Exception {
        sync(() -> {
            require(name).delete(); // hides it, unregisters it and deletes its file
            return null;
        });
    }

    void teleport(String playerName, String name) throws Exception {
        sync(() -> {
            Hologram h = require(name);
            Player p = Bukkit.getPlayerExact(playerName);
            if (p == null) throw new ApiException(404, playerName + " isn't online.");
            Location target = h.getLocation().clone().add(0, 0, 2);
            target.setDirection(h.getLocation().toVector().subtract(target.toVector()));
            p.teleportAsync(target);
            return null;
        });
    }

    private void checkCurrent(String original, String fingerprint) {
        if (original == null) return;
        Hologram old = manager().getHologram(original);
        if (old == null) throw new ApiException(404, "Hologram '" + original + "' doesn't exist anymore.");
        if (fingerprint != null && !fingerprint.equals(fingerprint(toJson(old)))) {
            throw new ApiException(409, "Someone changed '" + original + "' since you opened it (in game or in another tab). Reload it to see their changes.");
        }
    }

    private Hologram apply(String original, String name, String yaml) throws IOException {
        Hologram old = original == null ? null : manager().getHologram(original);
        boolean renamed = original == null || !original.equals(name);
        if (renamed && (manager().containsHologram(name) || Hologram.getCachedHologram(name) != null)) {
            throw new ApiException(409, "A hologram called '" + name + "' already exists.");
        }

        File folder = new File(DecentHologramsAPI.get().getDataFolder(), "holograms");
        File oldFile = old == null ? null : file(old);
        File target = oldFile != null && !renamed ? oldFile : new File(oldFile != null ? oldFile.getParentFile() : folder, name + ".yml");
        if (renamed && target.exists()) throw new ApiException(409, "There's already a file called " + target.getName() + " in the holograms folder.");
        String backup = oldFile != null && oldFile.exists() ? Files.readString(oldFile.toPath(), StandardCharsets.UTF_8) : null;

        if (old != null) old.destroy(); // unregisters it but keeps its file
        target.getParentFile().mkdirs();
        Files.writeString(target.toPath(), yaml, StandardCharsets.UTF_8);
        try {
            Hologram h = Hologram.fromFile(relative(folder, target));
            manager().registerHologram(h);
            if (oldFile != null && !oldFile.equals(target)) Files.deleteIfExists(oldFile.toPath());
            return h;
        } catch (Exception e) {
            if (!target.equals(oldFile)) Files.deleteIfExists(target.toPath());
            if (backup != null) {
                Files.writeString(oldFile.toPath(), backup, StandardCharsets.UTF_8);
                try {
                    manager().registerHologram(Hologram.fromFile(relative(folder, oldFile)));
                } catch (Exception restore) {
                    plugin.getLogger().warning("Couldn't reload '" + original + "' after a failed save: " + restore.getMessage());
                }
            }
            String why = e.getMessage() == null ? e.getClass().getSimpleName() : firstLine(e.getMessage());
            throw new ApiException(400, "DecentHolograms couldn't load that: " + why);
        }
    }

    // ------------------------------------------------------------------ conversion

    private static JsonObject toJson(Hologram h) {
        JsonObject o = new JsonObject();
        Location loc = h.getLocation();
        o.addProperty("name", h.getName());
        o.addProperty("world", loc.getWorld() == null ? "" : loc.getWorld().getName());
        o.addProperty("x", round(loc.getX()));
        o.addProperty("y", round(loc.getY()));
        o.addProperty("z", round(loc.getZ()));
        o.addProperty("enabled", h.isEnabled());
        o.addProperty("permission", h.getPermission() == null ? "" : h.getPermission());
        o.add("flags", flags(h.getFlags()));
        o.addProperty("displayRange", h.getDisplayRange());
        o.addProperty("updateRange", h.getUpdateRange());
        o.addProperty("updateInterval", h.getUpdateInterval());
        o.addProperty("facing", h.getFacing());
        o.addProperty("downOrigin", h.isDownOrigin());

        JsonArray pages = new JsonArray();
        for (HologramPage page : h.getPages()) {
            JsonObject p = new JsonObject();
            JsonArray lines = new JsonArray();
            for (HologramLine line : page.getLines()) {
                JsonObject l = new JsonObject();
                l.addProperty("content", line.getContent());
                l.addProperty("type", line.getType().name());
                l.addProperty("height", line.getHeight());
                l.addProperty("offsetX", line.getOffsetX());
                l.addProperty("offsetZ", line.getOffsetZ());
                if (line.getFacing() != h.getFacing()) l.addProperty("facing", line.getFacing());
                l.addProperty("permission", line.getPermission() == null ? "" : line.getPermission());
                l.add("flags", flags(line.getFlags()));
                lines.add(l);
            }
            p.add("lines", lines);
            JsonObject actions = new JsonObject();
            for (ClickType click : ClickType.values()) {
                List<Action> list = page.getActions(click);
                if (list == null || list.isEmpty()) continue;
                actions.add(click.name(), strings(list.stream().map(Action::toString).toList()));
            }
            p.add("actions", actions);
            pages.add(p);
        }
        o.add("pages", pages);
        File file = file(h);
        o.addProperty("file", file == null ? "" : file.getName());
        return o;
    }

    /** Builds a hologram file the same way {@code Hologram.save()} does. */
    private static String yamlFor(JsonObject dto) {
        YamlConfiguration y = new YamlConfiguration();
        y.set("location", String.format(Locale.ROOT, "%s:%.3f:%.3f:%.3f", str(dto, "world"), num(dto, "x", 0), num(dto, "y", 0), num(dto, "z", 0)));
        y.set("enabled", bool(dto, "enabled", true));
        String permission = str(dto, "permission").trim();
        if (!permission.isEmpty()) y.set("permission", permission);
        List<String> flags = flagList(dto);
        if (!flags.isEmpty()) y.set("flags", flags);
        y.set("display-range", (int) clamp(num(dto, "displayRange", 48), 1, 512));
        y.set("update-range", (int) clamp(num(dto, "updateRange", 48), 1, 512));
        y.set("update-interval", (int) clamp(num(dto, "updateInterval", 20), 1, 72000));
        double facing = num(dto, "facing", 0);
        y.set("facing", facing);
        y.set("down-origin", bool(dto, "downOrigin", false));

        List<Map<String, Object>> pages = new ArrayList<>();
        JsonArray pageArray = dto.has("pages") && dto.get("pages").isJsonArray() ? dto.getAsJsonArray("pages") : new JsonArray();
        for (JsonElement pe : pageArray) {
            JsonObject page = pe.getAsJsonObject();
            List<Map<String, Object>> lines = new ArrayList<>();
            JsonArray lineArray = page.has("lines") ? page.getAsJsonArray("lines") : new JsonArray();
            for (JsonElement le : lineArray) {
                JsonObject line = le.getAsJsonObject();
                Map<String, Object> l = new LinkedHashMap<>();
                l.put("content", str(line, "content"));
                l.put("height", clamp(num(line, "height", 0.3), -10, 10));
                List<String> lineFlags = flagList(line);
                if (!lineFlags.isEmpty()) l.put("flags", lineFlags);
                String linePerm = str(line, "permission").trim();
                if (!linePerm.isEmpty()) l.put("permission", linePerm);
                double ox = num(line, "offsetX", 0), oz = num(line, "offsetZ", 0);
                if (ox != 0) l.put("offsetX", ox);
                if (oz != 0) l.put("offsetZ", oz);
                if (line.has("facing") && !line.get("facing").isJsonNull()) {
                    double lf = num(line, "facing", facing);
                    if (lf != facing) l.put("facing", lf);
                }
                lines.add(l);
            }
            Map<String, List<String>> actions = new LinkedHashMap<>();
            if (page.has("actions") && page.get("actions").isJsonObject()) {
                for (ClickType click : ClickType.values()) {
                    JsonElement list = page.getAsJsonObject("actions").get(click.name());
                    if (list == null || !list.isJsonArray()) continue;
                    List<String> entries = new ArrayList<>();
                    for (JsonElement a : list.getAsJsonArray()) {
                        String s = a.getAsString().trim();
                        if (!s.isEmpty()) entries.add(s);
                    }
                    if (!entries.isEmpty()) actions.put(click.name(), entries);
                }
            }
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("lines", lines);
            p.put("actions", actions);
            pages.add(p);
        }
        if (pages.isEmpty()) {
            Map<String, Object> p = new LinkedHashMap<>();
            p.put("lines", new ArrayList<>());
            p.put("actions", new LinkedHashMap<>());
            pages.add(p);
        }
        y.set("pages", pages);
        return y.saveToString();
    }

    // ------------------------------------------------------------------ helpers

    <T> T sync(Callable<T> task) throws Exception {
        if (Bukkit.isPrimaryThread()) return task.call();
        try {
            return Bukkit.getScheduler().callSyncMethod(plugin, task).get(15, TimeUnit.SECONDS);
        } catch (ExecutionException e) {
            if (e.getCause() instanceof Exception cause) throw cause;
            throw e;
        } catch (TimeoutException e) {
            throw new ApiException(503, "The server didn't respond in time. Is it lagging or stopping?");
        }
    }

    private static HologramManager manager() {
        return DecentHologramsAPI.get().getHologramManager();
    }

    private static Hologram require(String name) {
        Hologram h = manager().getHologram(name);
        if (h == null) throw new ApiException(404, "There's no hologram called '" + name + "'.");
        return h;
    }

    private static File file(Hologram h) {
        return h.getConfig() == null ? null : h.getConfig().getFile();
    }

    private static String relative(File folder, File file) {
        return folder.toPath().relativize(file.toPath()).toString().replace('\\', '/');
    }

    private static String fingerprint(JsonObject o) {
        JsonObject copy = o.deepCopy();
        copy.remove("fingerprint");
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(GSON.toJson(copy).getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash, 0, 12);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static JsonArray flags(Set<EnumFlag> flags) {
        return strings(flags.stream().map(Enum::name).sorted().toList());
    }

    private static List<String> flagList(JsonObject o) {
        List<String> out = new ArrayList<>();
        if (!o.has("flags") || !o.get("flags").isJsonArray()) return out;
        for (JsonElement e : o.getAsJsonArray("flags")) {
            String f = e.getAsString();
            try {
                out.add(EnumFlag.valueOf(f).name());
            } catch (IllegalArgumentException ex) {
                throw new ApiException(400, "Unknown flag " + f);
            }
        }
        return out;
    }

    private static JsonArray strings(List<String> list) {
        JsonArray a = new JsonArray();
        list.forEach(a::add);
        return a;
    }

    private static String str(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? "" : e.getAsString();
    }

    private static double num(JsonObject o, String key, double fallback) {
        JsonElement e = o.get(key);
        if (e == null || e.isJsonNull()) return fallback;
        try {
            double d = e.getAsDouble();
            return Double.isFinite(d) ? d : fallback;
        } catch (Exception ex) {
            throw new ApiException(400, key + " must be a number.");
        }
    }

    private static boolean bool(JsonObject o, String key, boolean fallback) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? fallback : e.getAsBoolean();
    }

    private static double clamp(double v, double min, double max) {
        return Math.max(min, Math.min(max, v));
    }

    private static double round(double v) {
        return Math.round(v * 1000) / 1000.0;
    }

    private static String firstLine(String s) {
        int nl = s.indexOf('\n');
        return nl < 0 ? s : s.substring(0, nl);
    }
}
