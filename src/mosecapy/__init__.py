"""mosecapy.

This is the mosecapy package, which provides various utilities for working with
Moseca data and models.
"""

import warnings
from pathlib import Path

import click
from pydub import AudioSegment

from mosecapy.app.service.demucs_runner import separator

__version__ = "1.0.0"


def export_drumless(
    input_file_path: Path,
    output_dir: Path,
    model: str,
) -> None:
    """Export drumless sound file."""
    sound1: AudioSegment = AudioSegment.from_file(
        output_dir / model / input_file_path.stem / "vocals.mp3",
        format="mp3",
    )
    sound2: AudioSegment = AudioSegment.from_file(
        output_dir / model / input_file_path.stem / "bass.mp3",
        format="mp3",
    )
    sound3: AudioSegment = AudioSegment.from_file(
        output_dir / model / input_file_path.stem / "other.mp3",
        format="mp3",
    )

    overlay = sound1.overlay(sound2, position=0).overlay(sound3, position=0)
    file_handle = overlay.export(
        output_dir / (input_file_path.stem + "_drumless.mp3"),
        format="mp3",
    )
    print(f"Finished exporting {file_handle.name}")


@click.command()
@click.option("--input_dir", default="music", help="Path to the input audio folder.")
@click.option("--output_dir", default="split", help="Directory to save the output files.")
@click.option("--model", default="htdemucs", help="Model to use for separation.")
def cli(input_dir: str, output_dir: str, model: str) -> None:
    """Cli tool to use mosecapy."""
    warnings.simplefilter("ignore", UserWarning)
    warnings.simplefilter("ignore", FutureWarning)

    input_dir: Path = Path(input_dir)
    output_dir: Path = Path(output_dir)

    input_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)

    separator(
        tracks=list(input_dir.iterdir()),
        out=output_dir,
        model=model,
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

    for input_file in input_dir.iterdir():
        export_drumless(input_dir / input_file, output_dir, model)
