package dev.smp.holoportal;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import eu.decentsoftware.holograms.api.DecentHologramsAPI;
import org.bukkit.configuration.InvalidConfigurationException;
import org.bukkit.configuration.file.YamlConfiguration;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Reads and edits DecentHolograms custom text animations: {@code plugins/DecentHolograms/animations/<name>.yml}
 * with {@code speed} (ticks per frame), {@code pause} (ticks to hold the last frame) and {@code steps}
 * (the frames; {@code {text}} is replaced by the text inside the animation tag).
 * <p>
 * DH only reads these files when its animations reload, so every save reloads them. Runs on the
 * server thread (callers go through {@link HologramService#sync}).
 */
final class AnimationEditor {

    private static final Pattern NAME = Pattern.compile("[a-zA-Z0-9_-]+");
    /** Built-in animations, with the speed and pause DH gives them. Their names can't be reused. */
    static final List<Object[]> BUILT_IN = List.of(
            new Object[]{"typewriter", 3, 20}, new Object[]{"wave", 2, 40}, new Object[]{"burn", 2, 40},
            new Object[]{"scroll", 3, 0}, new Object[]{"colors", 4, 0});
    private static final List<String> RESERVED = List.of("typewriter", "wave", "burn", "scroll", "colors", "colours");

    // ------------------------------------------------------------------ reads

    JsonArray list() {
        JsonArray out = new JsonArray();
        for (File f : files()) {
            YamlConfiguration y = YamlConfiguration.loadConfiguration(f);
            String name = nameOf(f);
            JsonObject o = new JsonObject();
            o.addProperty("name", name);
            o.addProperty("world", "");
            o.addProperty("speed", y.getInt("speed", 1));
            o.addProperty("pause", y.getInt("pause", 1));
            List<String> steps = y.getStringList("steps");
            o.addProperty("frames", steps.size());
            o.addProperty("preview", steps.isEmpty() ? "" : steps.get(0).replace("{text}", "Text"));
            o.addProperty("loaded", DecentHologramsAPI.get().getAnimationManager().getAnimation(name) != null);
            out.add(o);
        }
        return out;
    }

    /** Every animation DH knows (built-in and custom) with what the editor needs to play it. */
    JsonArray definitions() {
        JsonArray out = new JsonArray();
        for (Object[] b : BUILT_IN) {
            JsonObject o = new JsonObject();
            o.addProperty("name", (String) b[0]);
            o.addProperty("builtin", true);
            o.addProperty("speed", (Integer) b[1]);
            o.addProperty("pause", (Integer) b[2]);
            out.add(o);
        }
        for (File f : files()) {
            YamlConfiguration y = YamlConfiguration.loadConfiguration(f);
            JsonObject o = new JsonObject();
            o.addProperty("name", nameOf(f));
            o.addProperty("builtin", false);
            o.addProperty("speed", y.getInt("speed", 1));
            o.addProperty("pause", y.getInt("pause", 1));
            o.add("steps", strings(y.getStringList("steps")));
            out.add(o);
        }
        return out;
    }

    JsonObject get(String name) {
        File f = require(name);
        YamlConfiguration y = YamlConfiguration.loadConfiguration(f);
        JsonObject o = new JsonObject();
        o.addProperty("name", name);
        o.addProperty("speed", y.isInt("speed") ? y.getInt("speed") : 1);
        o.addProperty("pause", y.isInt("pause") ? y.getInt("pause") : 1);
        o.add("steps", strings(y.getStringList("steps")));
        o.addProperty("loaded", DecentHologramsAPI.get().getAnimationManager().getAnimation(name) != null);
        o.add("usedIn", usages(name));
        o.addProperty("fingerprint", fingerprint(f));
        return o;
    }

    String yaml(String name) throws IOException {
        return Files.readString(require(name).toPath(), StandardCharsets.UTF_8);
    }

    // ------------------------------------------------------------------ writes

    JsonObject save(String original, String fingerprint, JsonObject dto) throws IOException {
        String name = str(dto, "name").trim();
        checkName(name);
        checkCurrent(original, fingerprint);
        List<String> steps = new ArrayList<>();
        if (dto.has("steps") && dto.get("steps").isJsonArray()) {
            for (JsonElement e : dto.getAsJsonArray("steps")) steps.add(e.isJsonNull() ? "" : e.getAsString());
        }
        if (steps.isEmpty()) throw new ApiException(400, "An animation needs at least one frame.");
        YamlConfiguration y = new YamlConfiguration();
        y.set("speed", (int) clamp(num(dto, "speed", 1), 1, 1200));
        y.set("pause", (int) clamp(num(dto, "pause", 0), 0, 72000));
        y.set("steps", steps);
        return apply(original, name, y.saveToString());
    }

    JsonObject saveYaml(String name, String fingerprint, String yaml) throws IOException {
        checkCurrent(name, fingerprint);
        YamlConfiguration test = new YamlConfiguration();
        try {
            test.loadFromString(yaml);
        } catch (InvalidConfigurationException e) {
            throw new ApiException(400, "That isn't valid YAML: " + firstLine(e.getMessage()));
        }
        if (!test.isList("steps") || test.getStringList("steps").isEmpty()) {
            throw new ApiException(400, "The YAML needs a steps: list with at least one frame.");
        }
        return apply(name, name, yaml);
    }

    void delete(String name) throws IOException {
        Files.delete(require(name).toPath());
        reload();
    }

    private void checkName(String name) {
        // DH's animation tags only match \w+, so a "-" would make the animation unusable.
        if (!name.matches("\\w+")) throw new ApiException(400, "Animation names can only use letters, numbers and _ (DecentHolograms can't use - in animation tags).");
        if (RESERVED.contains(name.toLowerCase(Locale.ROOT))) throw new ApiException(400, "'" + name + "' is a built-in animation. Pick another name.");
    }

    private void checkCurrent(String original, String fingerprint) {
        if (original == null) return;
        File f = find(original);
        if (f == null) throw new ApiException(404, "Animation '" + original + "' doesn't exist anymore.");
        if (fingerprint != null && !fingerprint.equals(fingerprint(f))) {
            throw new ApiException(409, "Someone changed '" + original + "' since you opened it. Reload it to see their changes.");
        }
    }

    private JsonObject apply(String original, String name, String yaml) throws IOException {
        boolean renamed = original == null || !original.equals(name);
        File oldFile = original == null ? null : find(original);
        if (renamed && find(name) != null) throw new ApiException(409, "An animation called '" + name + "' already exists.");
        File target = renamed || oldFile == null ? new File(folder(), name + ".yml") : oldFile;
        String backup = oldFile != null ? Files.readString(oldFile.toPath(), StandardCharsets.UTF_8) : null;

        target.getParentFile().mkdirs();
        Files.writeString(target.toPath(), yaml, StandardCharsets.UTF_8);
        if (renamed && oldFile != null) Files.deleteIfExists(oldFile.toPath());
        reload();
        if (DecentHologramsAPI.get().getAnimationManager().getAnimation(name) == null) {
            Files.deleteIfExists(target.toPath());
            if (backup != null) Files.writeString(oldFile.toPath(), backup, StandardCharsets.UTF_8);
            reload();
            throw new ApiException(400, "DecentHolograms couldn't load that animation. Check the server console.");
        }
        return get(name);
    }

    private static void reload() {
        DecentHologramsAPI.get().getAnimationManager().reload();
    }

    /** Holograms and displays whose files use this animation. */
    private static JsonArray usages(String name) {
        Pattern use = Pattern.compile("[<{]#?ANIM:" + Pattern.quote(name) + "[:}>]");
        JsonArray out = new JsonArray();
        for (String[] kind : new String[][]{{"holograms", "hologram"}, {"displays", "display"}}) {
            File[] fs = new File(DecentHologramsAPI.get().getDataFolder(), kind[0]).listFiles((d, n) -> n.endsWith(".yml"));
            if (fs == null) continue;
            Arrays.sort(fs);
            for (File f : fs) {
                try {
                    if (!use.matcher(Files.readString(f.toPath(), StandardCharsets.UTF_8)).find()) continue;
                } catch (IOException e) {
                    continue;
                }
                JsonObject o = new JsonObject();
                o.addProperty("kind", kind[1]);
                String n = f.getName().substring(0, f.getName().length() - 4);
                o.addProperty("name", kind[1].equals("hologram") && n.toLowerCase(Locale.ROOT).startsWith("hologram_") ? n.substring(9) : n);
                out.add(o);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ helpers

    private static File folder() {
        return new File(DecentHologramsAPI.get().getDataFolder(), "animations");
    }

    private static List<File> files() {
        File[] fs = folder().listFiles((d, n) -> n.endsWith(".yml") && NAME.matcher(n.substring(0, n.length() - 4)).matches());
        List<File> list = fs == null ? new ArrayList<>() : new ArrayList<>(Arrays.asList(fs));
        list.sort((a, b) -> nameOf(a).compareToIgnoreCase(nameOf(b)));
        return list;
    }

    /** DH names animation_<x>.yml "x", like holograms. */
    private static String nameOf(File f) {
        String n = f.getName().substring(0, f.getName().length() - 4);
        return n.toLowerCase(Locale.ROOT).startsWith("animation_") && n.length() > 10 ? n.substring(10) : n;
    }

    private static File find(String name) {
        if (!NAME.matcher(name).matches()) return null;
        for (File f : files()) if (nameOf(f).equals(name)) return f;
        return null;
    }

    private static File require(String name) {
        File f = find(name);
        if (f == null) throw new ApiException(404, "There's no animation called '" + name + "'.");
        return f;
    }

    private static String fingerprint(File f) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(f.toPath()));
            return HexFormat.of().formatHex(hash, 0, 12);
        } catch (Exception e) {
            return "";
        }
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
            return e.getAsDouble();
        } catch (Exception ex) {
            throw new ApiException(400, key + " must be a number.");
        }
    }

    private static double clamp(double v, double min, double max) {
        return Math.max(min, Math.min(max, v));
    }

    private static String firstLine(String s) {
        int nl = s.indexOf('\n');
        return nl < 0 ? s : s.substring(0, nl);
    }
}
