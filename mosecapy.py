from pathlib import Path
import warnings
import os
from pydub import AudioSegment

from app.service.vocal_remover.runner import load_model
from app.service.demucs_runner import separator

warnings.simplefilter("ignore", UserWarning)
warnings.simplefilter("ignore", FutureWarning)


def transform(input):
    args = {
        "input": input,
        "full_mode": True,
        "pretrained_model": "baseline.pth",
        "model": "htdemucs",
        "output_dir": "split",
    }

    input_file = args["input"]
    _full_mode = bool(args["full_mode"])
    model, device = load_model(pretrained_model=args["pretrained_model"])

    separator(
        tracks=[Path(input_file)],
        out=Path(args["output_dir"]),
        model="htdemucs",
        shifts=1,
        overlap=0.5,
        stem=None,
        int24=False,
        float32=False,
        clip_mode="rescale",
        mp3=True,
        mp3_bitrate=320,
        verbose=False,
    )

    sound1 = AudioSegment.from_file(
        os.path.join(args["output_dir"], args["model"], args["input"].split("/")[-1].replace(".flac", ""), "vocals.mp3"), format="mp3"
    )
    sound2 = AudioSegment.from_file(
        os.path.join(args["output_dir"], args["model"], args["input"].split("/")[-1].replace(".flac", ""), "bass.mp3"), format="mp3"
    )
    sound3 = AudioSegment.from_file(
        os.path.join(args["output_dir"], args["model"], args["input"].split("/")[-1].replace(".flac", ""), "other.mp3"), format="mp3"
    )

    overlay = sound1.overlay(sound2, position=0).overlay(sound3, position=0)
    _file_handle = overlay.export(
        os.path.join(args["output_dir"], args["input"].split("/")[-1].replace(".flac", "") + "_drumless.mp3"), format="mp3"
    )


os.makedirs("music", exist_ok=True)
os.makedirs("split", exist_ok=True)

for input in os.listdir("music"):
    transform(os.path.join("music", input))
