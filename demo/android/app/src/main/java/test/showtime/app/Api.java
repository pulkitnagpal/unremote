package test.showtime.app;

import android.content.SharedPreferences;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.json.JSONObject;

/** The app's private API client: bearer token, refresh on 401, device id and app version headers. */
final class Api {
  static final String BASE = "https://10.0.2.2:8443";
  private final SharedPreferences prefs;

  Api(SharedPreferences prefs) {
    this.prefs = prefs;
    if (!prefs.contains("device_id")) prefs.edit().putString("device_id", UUID.randomUUID().toString()).apply();
  }

  boolean signedIn() { return prefs.contains("access_token"); }

  JSONObject get(String path) throws Exception { return call("GET", path, null, true); }
  JSONObject post(String path, JSONObject body) throws Exception { return call("POST", path, body, true); }

  void login(String email, String password) throws Exception {
    JSONObject r = call("POST", "/v2/auth/login", new JSONObject().put("email", email).put("password", password), false);
    save(r);
  }

  void track(String event, String screen) {
    try { call("POST", "/collect", new JSONObject().put("event", event).put("screen", screen).put("ts", System.currentTimeMillis()), false); } catch (Exception ignored) {}
  }

  private void save(JSONObject r) throws Exception {
    prefs.edit().putString("access_token", r.getString("access_token")).putString("refresh_token", r.getString("refresh_token")).apply();
  }

  private JSONObject call(String method, String path, JSONObject body, boolean retry) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(BASE + path).openConnection();
    c.setRequestMethod(method);
    c.setConnectTimeout(8000);
    c.setReadTimeout(8000);
    c.setRequestProperty("accept", "application/json");
    c.setRequestProperty("x-device-id", prefs.getString("device_id", ""));
    c.setRequestProperty("x-app-version", "1.0.0");
    String token = prefs.getString("access_token", null);
    if (token != null) c.setRequestProperty("authorization", "Bearer " + token);
    if (body != null) {
      c.setDoOutput(true);
      c.setRequestProperty("content-type", "application/json");
      try (OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
    }
    int code = c.getResponseCode();
    String text = read(code < 400 ? c.getInputStream() : c.getErrorStream());
    if (code == 401 && retry && prefs.contains("refresh_token")) {
      try {
        save(call("POST", "/v2/auth/refresh", new JSONObject().put("refresh_token", prefs.getString("refresh_token", "")), false));
      } catch (Exception e) {
        prefs.edit().remove("access_token").remove("refresh_token").apply();
        throw new Exception("Please log in again");
      }
      return call(method, path, body, false);
    }
    if (code >= 400) throw new Exception("HTTP " + code + ": " + text);
    return text.isEmpty() ? new JSONObject() : new JSONObject(text);
  }

  private static String read(InputStream in) throws Exception {
    if (in == null) return "";
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
    return b.toString("UTF-8");
  }
}
