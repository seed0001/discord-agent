"""Quick smoke test for gudda_bridge.py"""
from gudda_bridge import (
    GuddaBridge, HDVector, BinaryHDVector,
    encode_text, encode_turn, bundle_all,
    sdm_snr_threshold, sdm_mem_radius, sdm_centroid_radius,
    native_available,
)

print("=== GuddaBridge Smoke Test ===")
print(f"native_available: {native_available()}")

bridge = GuddaBridge()
print(f"Bridge: {bridge}")

# --- BinaryHDVector basics ---
a = BinaryHDVector.from_key("hello", 256)
b = BinaryHDVector.from_key("world", 256)
sim_ab = a.xnor_popcount_similarity(b)
sim_aa = a.xnor_popcount_similarity(a)
print(f"from_key sim(hello,world): {sim_ab:.4f}")
print(f"from_key sim(hello,hello): {sim_aa:.4f}")
assert sim_aa == 1.0, "self-similarity must be 1.0"
assert 0.4 < sim_ab < 0.6, "unrelated vectors should be near 0.5"

# --- bind / bundle ---
bound = a.bind(b)
print(f"bind sim(a): {bound.xnor_popcount_similarity(a):.4f}")
print(f"bind sim(b): {bound.xnor_popcount_similarity(b):.4f}")
# After XOR binding, bound is decorrelated from both parents:
# sim(a⨁b, a) == sim(b) ≈ 0.5 for random unrelated vectors
assert bound.xnor_popcount_similarity(b) > 0.3, "bind still has some residual similarity"

bundle_ab = a.bundle(b)
print(f"bundle sim(a): {bundle_ab.xnor_popcount_similarity(a):.4f}")
assert bundle_ab.xnor_popcount_similarity(a) > 0.5, "bundle should preserve similarity to parents"

# --- n-gram encoding ---
text_a = encode_text("The quick brown fox", dim=256)
text_b = encode_text("The quick brown fox", dim=256)
text_c = encode_text("Something completely different", dim=256)
print(f"encode_text same:  {text_a.xnor_popcount_similarity(text_b):.4f}")
assert text_a.xnor_popcount_similarity(text_b) == 1.0, "same text → identical vectors"
same_sim = text_a.xnor_popcount_similarity(text_c)
print(f"encode_text diff:  {same_sim:.4f}")
assert same_sim < 0.7, "different texts should be further apart (dim=256)"

# --- turn encoding ---
turn = encode_turn("Alice", "Hello world", 1234.5, "discord", dim=256)
turn2 = encode_turn("Bob", "Goodbye world", 6789.0, "discord", dim=256)
print(f"turn vec: {turn}")
print(f"sim different turns: {turn.xnor_popcount_similarity(turn2):.4f}")

# --- bundle_all ---
c = BinaryHDVector.from_key("third", 256)
bundled = bundle_all(a, b, c, dim=256)
print(f"bundle_all sim(a): {bundled.xnor_popcount_similarity(a):.4f}")
assert bundled.xnor_popcount_similarity(a) > 0.5, "3-vector bundle should be similar to each component"

# --- SDM thresholds ---
print(f"SDM SNR (256d):      {sdm_snr_threshold(256):.1f}")
print(f"SDM mem (256d):       {sdm_mem_radius(256):.1f}")
print(f"SDM centroid (256d): {sdm_centroid_radius(256):.1f}")

# --- HDVector MAP ---
h = HDVector.from_key("test", 256)
print(f"HDVector MAP: {h}")

# --- MAP ↔ BSC conversion ---
bsc = h.to_binary()
print(f"MAP to BinaryHDVector sim: {bsc.xnor_popcount_similarity(BinaryHDVector.from_key('test', 256)):.4f}")

print()
print("=== ALL PASS ===")
