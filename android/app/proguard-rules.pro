# Release builds are not minified yet (isMinifyEnabled = false).
# If minification is turned on, keep the WebRTC JNI bindings:
-keep class org.webrtc.** { *; }
